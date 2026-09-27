# Provider-neutral publishing contract (R10)

Status: **code-complete** for the engine, receipts, reconciliation, UI and
tests. The **only** blocked piece is the concrete Agent Social Gateway
*submission* call (label: `EXTERNAL_CONTRACT`) because the Gateway does not
expose a publication endpoint today. Nothing in this repo invents one.

## 1. Layers

| Layer | File | Responsibility |
| --- | --- | --- |
| Contract | `lib/publishing/contract.ts` | `PublishingProvider`, `PublishRequest`, `PublishOutcome`, capability levels, registry, outcome validation, failure classification. No provider specifics. |
| Engine | `lib/publishing/engine.ts` | Idempotency, receipts, polling of accepted operations, ambiguity handling, partial success, retry decisions, variant state transitions. Identical for every provider. |
| Task integration | `lib/publishing/service.ts` (`content.publish`) | Loads content, validates platform rules, resolves the provider, presigns media, hands off to the engine. |
| Gateway adapter | `lib/publishing/gateway-provider.ts` | Maps the Gateway operation model onto `PublishOutcome`. Narrow `GatewayPublishingTransport` seam; default transport is blocked. |
| Legacy seam | `capabilities.ts` `registerApiPublishAdapter` | R4 synchronous adapters are wrapped with `providerFromApiAdapter` (non-idempotent, synchronous). |
| Receipts | `supabase/migrations/00038_publish_receipts.sql` | `publish_receipts` table, state-machine trigger, RLS (member read, service write), `confirm_manual_publication` (now records a receipt), `resolve_publication`. |
| UI | `app/(dashboard)/dashboard/content/[draftId]/page.tsx`, `components/campaigns/schedule-panel.tsx` | Per-variant attempt history; reconcile form for ambiguous attempts; API route reasons from provider capabilities. |
| API | `POST /api/v1/content/variants/{id}/reconcile` | `{ outcome: "published", externalUrl, externalRef? }` or `{ outcome: "not_published" }`. |

## 2. Outcomes

| Outcome | Receipt | Variant | Task |
| --- | --- | --- | --- |
| `published` | `published` (settled) | `published` + external ref/url | completed |
| `accepted` | `accepted` + `operation_ref` | stays `publishing` | deferred (`current_step = publish-op:<receipt>`), backoff 15 s → 10 min, honours provider hint |
| `partial` | `partial` + `parts[]` | `failed`, message with live-part count | **terminal** (`unknown_outcome`); never resubmitted (would duplicate live parts) |
| `failed` | `failed` + class/code | `queued` if the class retries and attempts remain, else `failed` | retry / give up per class; `final` forces give-up |
| `unknown` | `unknown` | `failed` with reconcile instructions | `waiting_for_user` |

The `publishing` state is kept while an operation is accepted. `reconcilePublishing`
skips variants whose task is `waiting` on a `publish-op:` step.

## 3. Idempotency rules

1. `idempotencyKey` = the variant schedule key (`publish:<variant>:v<version>:<epoch>`), identical on every retry.
2. A receipt row (`submitting`) is written **before** the provider call; `(workspace_id, idempotency_key, attempt)` is unique, so two executors cannot submit the same attempt.
3. Latest receipt for the key decides the next action:
   - `accepted` → poll `status(operation_ref)`; never resubmit.
   - `published` → finish the variant (crash-recovery), never resubmit.
   - `partial` → terminal again.
   - `submitting` (crash mid-call) → converted to `unknown`; stop for an operator.
   - `unknown` → resubmit **only** if the provider declares `idempotentSubmit`, or an operator retried the job (`human_intervention = resolved`) / chose "Not published — resubmit".
   - `failed` → new attempt.
4. Exceptions thrown by a non-idempotent provider with class `transient`/`internal` (timeouts, resets, 5xx) are **ambiguous** and become `unknown`, not a blind retry.
5. Accepted operations older than 24 h or polled 200 times become `unknown`.
6. A failed *status read* never marks the publication failed: transient read errors keep polling; others become `unknown`.

## 4. Capability checks

`PublishingProvider.capability(platform, kind)` returns `available` or
`unavailable` + reason. The engine refuses anything not `available` before any
receipt or provider call. `availableModes()` shows the first available
provider, else the reason from the provider that models the platform (for
Gateway platforms: the blocked-contract reason).

## 5. Gateway adapter

Known and used: `GatewayOperation` (`GET /v1/operations/{id}`). Mapping:

| Gateway operation | Outcome |
| --- | --- |
| `reconciliation_status = required` | `unknown` |
| `pending` / `running` | `accepted` (poll at `next_attempt_at`, min 5 s, default 30 s) |
| `failed`, retryable, not dead-lettered, `next_attempt_at` set, attempts left | `accepted` (the Gateway retries itself) |
| `failed` otherwise | `failed`, `final` (class `transient` if retryable else `validation`) |
| `succeeded` | `published` (`external_reference`; URL not invented → null) |
| `unknown` | `unknown` |

### What the Gateway must publish before the transport can be implemented (EXTERNAL_CONTRACT)

A concrete `GatewayPublishingTransport` needs, from the Gateway contract:

1. The submission endpoint path, method and auth (expected to reuse the existing bearer + workspace binding).
2. The request body mapping for `PublicationIntent` (account ref, platform, kind, text, media URLs + content types, idempotency key).
3. Whether submissions are deduplicated by idempotency key → sets `idempotentSubmit`.
4. The platform/kind matrix the Gateway can publish → `supports`.
5. Confirmation that the submission returns a `GatewayOperation` (or its id) readable via `GET /v1/operations/{id}`, and whether `succeeded` operations carry a public post URL.

Then: implement the transport (one file), call
`registerGatewayPublishingTransport(transport)` at server start-up, add a
contract test against the Gateway's published fixtures, and run one live
publish to a test account (PRODUCTION_CERTIFICATION).

## 6. Rollback

- Code: revert the R10 commit; `registerApiPublishAdapter` remains the entry point for R4 adapters.
- DB: 00038 is additive. `publish_receipts` can stay (unused) or be dropped with
  `drop table publish_receipts; drop function resolve_publication(uuid,text,text,text);`
  and `confirm_manual_publication` re-created from 00033's body. Never edit 00038 in place.

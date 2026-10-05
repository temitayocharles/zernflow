# Provider-neutral publishing contract (R10)

Status: **implemented** for the engine, receipts, reconciliation, UI and
Agent Social Gateway submission/polling transport. The Gateway now publishes
the durable publication contract used here: `POST /v1/publications` and
`GET /v1/operations/{id}`. Production availability remains capability-driven
and requires the server-side Gateway connection plus a commissioned provider
account.

## 1. Layers

| Layer | File | Responsibility |
| --- | --- | --- |
| Contract | `lib/publishing/contract.ts` | `PublishingProvider`, `PublishRequest`, `PublishOutcome`, capability levels, registry, outcome validation, failure classification. No provider specifics. |
| Engine | `lib/publishing/engine.ts` | Idempotency, receipts, polling of accepted operations, ambiguity handling, partial success, retry decisions, variant state transitions. Identical for every provider. |
| Task integration | `lib/publishing/service.ts` (`content.publish`) | Loads content, validates platform rules, resolves the provider, presigns media, hands off to the engine. |
| Gateway adapter | `lib/publishing/gateway-provider.ts` | Maps the published Gateway submission/operation contract onto `PublishOutcome`. The default transport is enabled only when the server-side Gateway URL and operator key are configured. |
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

### Published Gateway transport

The Gateway contract is now implemented by the default server-side transport:

1. Submit: `POST /v1/publications` with `X-API-Key`, `X-Workspace-Ref`,
   and `X-Actor-Ref`.
2. Body: account UUID, platform, kind, text, media URL/content-type pairs, and
   the stable idempotency key.
3. Submission is idempotent at the Gateway durable-operation boundary.
4. The currently commissioned matrix is intentionally narrow:
   `facebook/post`. Unsupported platform/kind pairs remain unavailable.
5. The response is the existing `GatewayOperation`, polled through
   `GET /v1/operations/{id}`.

Production certification still requires a credential-backed test provider
account and an explicitly intended test publication. The transport itself does
not fabricate provider support or create a test account.

## 6. Rollback

- Code: revert the R10 commit; `registerApiPublishAdapter` remains the entry point for R4 adapters.
- DB: 00038 is additive. `publish_receipts` can stay (unused) or be dropped with
  `drop table publish_receipts; drop function resolve_publication(uuid,text,text,text);`
  and `confirm_manual_publication` re-created from 00033's body. Never edit 00038 in place.

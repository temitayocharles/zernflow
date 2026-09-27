# ZernFlow — Current Architecture (audit baseline)

Audit date: 2026-09-25. Baseline commit: `12d7f2e` (`main`). Audit branch: `arena/01a0d989-zernflow`.

This document describes what the repository **actually does today**, with evidence. It is the input to
`DEAD_CODE_AND_REMOVAL_MANIFEST.md` and `TARGET_ARCHITECTURE.md`. It does not describe intended behavior.

## 1. Baseline validation evidence

| Check | Result (Node 22.22 local; CI uses Node 24) |
| --- | --- |
| `npm ci` | passes |
| `npm run typecheck` | passes |
| `npm test` | 283 tests / 44 files pass (includes full SQL history 00001–00029 in PGlite) |
| `npm run lint` | 0 errors, 44 warnings |
| `npm run build` | passes (54 routes) |
| `knip` static analysis | 2 unused files, 1 unused devDependency, 8 unused exports (see manifest) |

Git history is a single squashed commit, so historical intent is taken from `docs/` and code comments.

## 2. Runtime topology (as deployed per repository docs)

```text
Browser ──► Next.js 16 app (ZernFlow)  ── Supabase (Postgres + Auth + Realtime), project-isolated
              │  app router pages + /api/v1/* routes (user-scoped Supabase client, RLS)
              │  /api/cron/jobs, /api/cron/sequences (service role, CRON_SECRET)
              │  /api/webhooks/social-gateway (HMAC, service role)
              │  /api/webhooks/late (legacy Zernio, gated by ENABLE_LEGACY_ZERNIO)
              ▼
        Agent Social Gateway (separate repo/service): OAuth, provider accounts, Vault refs,
        authoritative conversations/messages, durable outbound operations, MCP
```

* Runtime platform: Northflank (per `docs/PROJECT_SOURCE_OF_TRUTH.md`); `vercel.json` still declares
  Vercel crons (stale for Northflank; harmless).
* Scheduling: an external scheduler must call the cron routes. There is no in-process worker.
* No object storage, no browser automation runtime, no secret store inside ZernFlow.

## 3. Code layout and responsibilities

| Area | Location | Notes |
| --- | --- | --- |
| Auth pages | `app/(auth)/*`, `app/auth/callback` | Supabase email/password (+ optional GitHub) |
| Workspace context | `lib/workspace.ts` (`getWorkspace`), `lib/product/api.ts` (`productContext`), ad-hoc `getWorkspace()` copies in `app/api/v1/channels/route.ts`, `channels/[channelId]/route.ts`, `flows/[flowId]/route.ts` | Three resolvers; the ad-hoc copies ignore the workspace cookie and act on the *first* membership |
| Flow automation | `lib/flow-engine/*`, `components/flow-builder/*`, `app/api/v1/flows/*` | Visual builder (xyflow), versions, publish, simulator, triggers |
| Comment automation | `lib/comment-processor.ts`, `app/(dashboard)/dashboard/growth` | comment keyword → public reply / private reply / DM flow |
| Inbox | `app/(dashboard)/dashboard/inbox`, `components/inbox/*`, `lib/inbox/*`, `app/api/v1/messages`, `conversations/*` | Gateway-backed reads, local projection, cursor paging, takeover/assign/escalate |
| Contacts / segments | `contacts`, `tags`, `custom_field_definitions`, `components/segment-builder.tsx` | |
| CRM | migration 00021, `lib/crm`, `app/api/v1/crm/*`, `dashboard/crm/*` | companies, customer profiles, deals, notes, activity |
| Service desk | 00022–00029, `lib/service-desk/*`, work items/queues/SLA/notifications | |
| Broadcasts | `broadcasts`, `broadcast_recipients`, `app/api/v1/broadcasts/*`, cron `send_broadcast` jobs | Sends through Gateway replies with idempotency keys |
| Sequences | `sequences`, `sequence_enrollments`, `lib/sequence-processor.ts`, `/api/cron/sequences` | Gateway operations persisted per step |
| Editorial | 00024 `editorial_drafts`/`editorial_variants`, `configuration/[resource]` pages | Local planning only; explicitly **not** executed |
| Knowledge | 00024 `knowledge_sources`, `lib/knowledge/*` | External retrieval seam |
| Mailbox identities | 00024 `mailbox_identities` | Configuration only, no email connector |
| Analytics | `dashboard/analytics` (flow events), `dashboard/operations` (operator metrics RPC), growth stats | Three analytics surfaces |
| Connectors | `lib/connectors/registry.ts`, `browser-session.ts` | Capability-driven presentation only; no browser runtime |
| Publishing | `lib/publishing/contracts.ts` | Interface only; no executor, no persistence of outcomes |
| Gateway client | `lib/social-gateway/*` | HTTP client with timeouts, typed errors, HMAC webhook verification |
| Legacy Zernio | `lib/zernio-client.ts`, `lib/zernio-webhook.ts`, `app/api/webhooks/late`, comment legacy reply (backfill removed in R8; AI node and channel DELETE moved to the Gateway in slice 1) | Legacy reply gated by `ENABLE_LEGACY_ZERNIO=true`. The late webhook is ungated; `LEGACY_ZERNIO_WEBHOOK=reject` is its brownout switch |

## 4. Data model (29 migrations)

Core (00001–00020): `workspaces`, `workspace_members`, `workspace_invites`, `channels`, `contacts`,
`contact_channels`, `tags`, `contact_tags`, `custom_field_definitions`, `contact_custom_fields`, `flows`,
`flow_versions`, `triggers`, `flow_sessions`, `conversations`, `messages`, `broadcasts`,
`broadcast_recipients`, `scheduled_jobs`, `analytics_events`, `comment_logs`, `sequences`,
`sequence_enrollments`, `webhook_events`.

Product (00021–00029): `companies`, `customer_profiles`, `deals`, `customer_notes`, `product_activity`,
`work_queues`, `work_items`, `canned_replies`, `operator_notifications`, `editorial_drafts`,
`editorial_variants`, `knowledge_sources`, `mailbox_identities` plus RPCs `operator_metrics`,
`workspace_operator_directory`, `bulk_update_work_items`, `refresh_sla_notifications`.

Newer tables (00021+) use composite `(workspace_id, id)` foreign keys, version guards and DB-side audit.
Older tables (00001–00013) rely on single-column FKs and parent-row RLS only.

## 5. Execution model today

* `scheduled_jobs` is the only durable queue: types `resume_flow`, `send_broadcast`,
  `process_social_gateway_event`. Claim is CAS on `(status, attempts)`, stale-claim recovery after 5 min,
  max 3 attempts, exponential backoff, Gateway-operation polling without consuming attempts.
* Sequences use their own polling loop over `sequence_enrollments`.
* SLA notifications run as a side effect of the jobs cron.
* There is no product-visible job/task object, no recurring schedules managed from the product, no dead-letter
  view, no execution record per external call, no correlation IDs.

## 6. Security findings (verified in code — must be fixed first)

| ID | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| S1 | Critical | Any authenticated user can **read, insert and update every row of `scheduled_jobs`** across tenants. Inserting `process_social_gateway_event` or `resume_flow` jobs lets an attacker run flows/send messages in another workspace through the service-role cron, bypassing webhook HMAC. Reading exposes other tenants' inbound message envelopes. | `00009_fix_broadcast_rls.sql` policies `auth.uid() IS NOT NULL`; `app/api/cron/jobs/route.ts` processes any row |
| S2 | Critical | Any workspace owner can import **all** Agent Social Gateway accounts visible to the deployment credential into their workspace (sign-up auto-creates an owned workspace), then read/reply to those conversations. | `app/api/v1/channels/sync/route.ts` uses `listAccounts()` without tenant binding; `channels` unique only per workspace |
| S3 | High | Flow `goToFlow` and `enrollSequence` load flows/sequences **by id only** with the service-role client → cross-tenant flow execution / sequence enrollment. | `lib/flow-engine/engine.ts` `executeFlow` and `executeEnrollSequence` |
| S4 | High | Flow `httpRequest` node performs **unrestricted server-side fetch** (SSRF to metadata/internal services, no timeout, unbounded body, follows redirects). Response can be echoed to a contact. | `executeHttpRequest` in `engine.ts` |
| S5 | High | Plaintext secrets `workspaces.ai_api_key`, `workspaces.late_api_key_encrypted` (misnamed; plaintext), `workspaces.webhook_secret`, `channels.webhook_secret` are readable by every workspace member via PostgREST, and the full workspace row is **serialized into the client `Sidebar` props** on every dashboard page. | `app/(dashboard)/layout.tsx` → `DashboardNavigation workspace={workspace}`; `lib/workspace.ts` selects `workspaces(*)` |
| S6 | High | Legacy tables accept cross-tenant references: a member can insert `sequence_enrollments`, `broadcast_recipients`, `contact_channels`, `contact_tags` rows pointing at another workspace's contacts/channels; workers then message foreign contacts. | 00002/00005/00009 policies check only the parent row |
| S7 | Medium | Cron routes accept the secret in a **query string** (`?key=`), which leaks into access logs, and compare non-constant-time. | `app/api/cron/*/route.ts` |
| S8 | Medium | Per-route `getWorkspace()` copies ignore the selected workspace cookie → a multi-workspace user can delete/list channels in the wrong workspace. | `app/api/v1/channels/route.ts`, `[channelId]/route.ts` |
| S9 | Low | `broadcasts.scheduled_for` is stored and displayed but **never honored** — "Send" always sends immediately; nothing sends scheduled broadcasts. | no consumer of `scheduled_for` |

## 7. Functional gaps against the mission

* No campaign object (only a free-text `editorial_drafts.campaign`).
* No publishing execution, calendar, per-channel publish state or receipts.
* No durable product task model, no recurring schedules, no approvals outside editorial.
* No secret store, no object storage, no artifacts, no browser execution plane.
* No dashboard (the `/dashboard` route redirects to flows); navigation lists 18 entries reflecting historical
  pages rather than a product model (three analytics pages, generic "configuration" pages).
* AI Response node only sends through legacy Zernio → it always cancels the run when legacy mode is off
  (broken in the supported configuration).

## 8. Boundary with Agent Social Gateway

The Gateway already owns provider OAuth, credentials (Vault references), normalized events, authoritative
messages and durable outbound operations. ZernFlow must not duplicate those ledgers. New ZernFlow-owned
responsibilities (campaigns, content, tasks, secrets for ZernFlow-executed actions, artifacts, browser
execution) are defined in `TARGET_ARCHITECTURE.md` with explicit rules for what may not cross the boundary.

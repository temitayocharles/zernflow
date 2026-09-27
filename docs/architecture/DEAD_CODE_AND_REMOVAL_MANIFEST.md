# Dead Code, Classification and Removal Manifest

Rule: nothing substantial is removed without (a) evidence of non-use **or** (b) a proven replacement, plus a
verification step. Historical migrations are never edited; schema removals happen through forward migrations
only, after data has been migrated and a release has shipped without reads.

Evidence sources: `knip@5` static analysis (2026-09-25), `grep` import graphs, route reachability from
navigation, migration history, repository docs.

## 1. Subsystem classification

| Subsystem | Class | Rationale / action |
| --- | --- | --- |
| Supabase auth, workspaces, members, invites, team actions | KEEP | Working foundation. Harden secret columns (S5). |
| Agent Social Gateway client, signed webhook receiver, durable webhook ledger/processor | KEEP | Correct boundary; add tenant binding (S2). |
| Flow engine + builder + versions + templates + simulator | KEEP / REFACTOR | Fix S3/S4; AI node send path → Gateway. |
| Comment automation (`comment-processor`, Growth page) | KEEP / CONSOLIDATE | Move under **Automations** navigation. |
| Inbox (views, cursor paging, control route) | KEEP | Add campaign attribution/task links later. |
| Contacts, tags, custom fields, segments | KEEP | Add integrity triggers (S6). |
| CRM (companies, profiles, deals, notes, activity) | KEEP | Surface under **Contacts** (Customer 360), not as a separate top-level product. |
| Work items / queues / SLA / notifications / canned replies | KEEP | Work items stay as the human task surface; link to durable tasks. |
| Broadcasts | KEEP / REFACTOR | Scheduling via server RPC; honor `scheduled_for` (S9). |
| Sequences | KEEP | Integrity triggers (S6). |
| `scheduled_jobs` internal queue | KEEP → CONSOLIDATE (later) | Remains the internal dispatcher for flow resumes/broadcasts/gateway events. Lock down RLS (S1). New product-level work uses `tasks`; migrate job types into `tasks` in a later phase. |
| Editorial drafts/variants | CONSOLIDATE | Become **Content items / channel variants** with publish state, linked to `campaigns`. No parallel content table. |
| `editorial_drafts.campaign` (free text) | CONSOLIDATE → REPLACE | Backfilled into `campaigns`, column retained read-only for one release. |
| Operator analytics + flow analytics + growth stats | CONSOLIDATE | One **Analytics** area with tabs; pages kept, navigation merged. |
| `configuration/[resource]` generic pages | REFACTOR | Keep as internal editors; primary entry points become Content / Settings. |
| Knowledge sources + retrieval seam | KEEP (seam) | Not primary nav; under Settings. |
| Mailbox identities | KEEP (seam) / UNKNOWN | No email connector exists. Moved out of primary nav into Settings. |
| `lib/connectors/browser-session.ts` presentation | KEEP → extended by browser execution plane | |
| `lib/publishing/contracts.ts` | REFACTOR | Becomes the provider-neutral publishing engine contract with persistence. |
| Legacy Zernio (`zernio-client`, `zernio-webhook`, `/api/webhooks/late`, legacy comment reply branch, `@zernio/node`) | REPLACE → REMOVE (staged) | Closed set enforced by `lib/legacy/zernio-boundary.test.ts`. The late webhook has **no** `ENABLE_LEGACY_ZERNIO` gate (it is live ingress), so stage 2 requires runtime evidence (see §3). |
| Zernio inbox backfill (`backfillInboxConversations` in `lib/inbox-sync.ts`) | **REMOVED (R8)** | Evidence: no non-test caller in `app/`, `lib/`, `scripts/` or `workers/` at the base commit `12d7f2e` or since (`git grep backfillInboxConversations 12d7f2e`), so it was unreachable. The live helper `upsertContactForSender` moved to `lib/contacts/sender.ts`, with direct tests replacing the coverage it had through the backfill tests. |
| AI Response node Zernio send | REPLACE (done in slice 1) | Now sends through the Gateway reply operation with idempotency. |
| Landing page links to `zernio-dev/zernflow`, "Powered by Zernio" badge, competitor comparison copy | **REPLACED (R8)** | The earlier "replaced" note was inaccurate: `app/page.tsx` still carried them. It was rewritten as a ZernFlow-native page. The source link is now `NEXT_PUBLIC_SOURCE_URL` (shown only when set). Page metadata was updated. `public/powered-by-zernio.svg` is unreferenced and is deleted in stage 2. |
| `vercel.json` crons | UNKNOWN → REMOVE after confirmation | Runtime is Northflank; keep until the operator confirms no Vercel deployment exists. |
| `lib/types/database.ts` (hand-maintained) | REFACTOR (R8: guarded) | `lib/types/database.generated.ts` is generated from the migrations (PGlite introspection, `npm run db:types`; CI fails when it is stale). `lib/types/database-drift.ts` fails `tsc` if the hand contract names a table, column or function the migrations lack, or types a nullable column as non-null. It carries 5 reviewed historical exceptions. The hand file stays the app contract because it narrows CHECK columns to unions and carries relationships. |
| `/api/v1/channels/test-key` (410 shim) | KEEP (temporary) → REMOVE | Intentional fail-safe for old bundles; remove one release after this branch ships. |

## 2. Static dead-code evidence (knip)

| Item | Evidence | Decision |
| --- | --- | --- |
| `lib/flow-engine/index.ts` | Unused file (no importers) | **REMOVED** in slice 1 (barrel with no consumers; engine modules imported directly). |
| `scripts/smoke-test.mjs` | Unused by code; operator-run legacy Zernio smoke | Keep until Zernio stage 2; then remove with `scripts/smoke-config.*`. |
| `pg` devDependency | Unused (PGlite used instead) | **REMOVED** in slice 1. |
| `scheduleJob` in `lib/scheduler.ts` | Unused export | **REMOVED** with scheduler refactor (broadcast scheduling moved to RPC). |
| `enrollContact` (`lib/actions/sequences.ts`) | Unused export | Keep: public server action intended for contact UI; wire or remove in Contacts slice. |
| `getActiveCommentTriggers`, `parseNumberedResponse`, `resetSocialGatewayClientForTests`, `SOCIAL_GATEWAY_WEBHOOK_TOLERANCE_SECONDS`, CRM constant exports | Used internally/tests only | Keep (low cost, test seams). |
| 32 unused exported types | Type-only | Keep; no runtime cost. |

## 3. Staged removal: legacy Zernio

Stage 1 (this branch): remove Zernio from the AI Response node; channel DELETE no longer requires Zernio
(local deactivation + Gateway remains authority); landing branding replaced. `ENABLE_LEGACY_ZERNIO` still
gates the remaining paths.

R8 (repo-side, done): the Zernio inbox backfill was removed (unreachable, with evidence above). An import boundary test freezes the remaining surface. The late webhook now emits `legacy_zernio_webhook_total{outcome}` and the `legacy.zernio_webhook.received` log line, and it honours `LEGACY_ZERNIO_WEBHOOK=reject` (410 Gone without processing) as a reversible brownout.

Stage 2 (requires runtime evidence — **operator action**):
1. Confirm in Northflank secret group `zernflow-runtime` that `ENABLE_LEGACY_ZERNIO` is unset/false.
2. Confirm `select count(*) from webhook_events where source='zernio' and received_at > now()-interval '30 days'` is 0, and that no `legacy.zernio_webhook.received` log lines appeared in the same window.
2b. Brownout: set `LEGACY_ZERNIO_WEBHOOK=reject` for at least 14 days with no operator-visible regression (roll back by unsetting it).
3. Confirm `select count(*) from workspaces where late_api_key_encrypted is not null` — values must be moved
   into the secret store or discarded with owner consent.
4. Then delete `app/api/webhooks/late`, `lib/zernio-*`, the Zernio branch of `comment-reply` (and its `late_api_key_encrypted` read in `comment-processor`), the Zernio `webhook_events` prune in the legacy jobs drain,
   `scripts/smoke-*`, `public/powered-by-zernio.svg`, `@zernio/node`; forward migration drops
   `workspaces.late_api_key_encrypted`, `workspaces.webhook_secret`, `channels.webhook_secret`,
   `channels.webhook_id`.

## 4. Duplicate abstractions

| Duplicate | Resolution |
| --- | --- |
| Three workspace resolvers (`getWorkspace`, `productContext`, ad-hoc per-route copies) | Ad-hoc copies replaced by the cookie-aware resolver (S8). |
| Two queues (`scheduled_jobs`, sequence polling) + new `tasks` | `tasks` is the product execution plane; legacy queues migrate in a later phase (documented in `EXECUTION_MODEL.md`). |
| Three analytics surfaces | Navigation consolidated; data sources unchanged. |
| Editorial "campaign" text vs campaigns | Campaign table + backfill. |
| Two cron endpoints (+ new work) vs 2 free Northflank cron jobs | Single `/api/cron/tick` orchestrates jobs, sequences, tasks, schedules and maintenance within a time budget; old endpoints kept for compatibility. |

## 5. Unused database objects

No table is provably unused. Candidates for later removal (after Zernio stage 2): `webhook_events` rows with
`source='zernio'` (pruned automatically), legacy secret columns listed in §3. `comment_logs` is live.
`analytics_events` is live. No drop migrations are included in this branch.

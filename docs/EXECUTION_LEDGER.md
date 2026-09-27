# ZernFlow Social OS — Execution Ledger

Live record of the consolidation program defined in `docs/architecture/`. Updated at the end of every slice.
The earlier `docs/LM_ARENA_EXECUTION_LEDGER.md` covers the prior CRM/service-desk program and is kept for history.

- Working branch: `arena/01a0d989-zernflow` (GitHub mirror; Forgejo stays canonical for CI/merge)
- Base: `main` @ `12d7f2e`
- Last updated: 2026-09-25

## Status overview

| Slice | Scope | Status |
|---|---|---|
| R0 | Audit + 11 architecture documents | **Done** |
| R1 | P0 security (S1–S9), SSRF-safe fetch, AI node via Gateway, first dead-code removals | **Done (code + local validation)**, not yet deployed |
| R2 | Execution plane (tasks, schedules, leases, tick, worker API, Jobs UI) | **Done (code + local validation)** — `ff7a02b` |
| R3 | Secret store (envelope encryption, Vault Transit, audit, UI, legacy import) | **Done (code + local validation)** |
| R4 | Campaign OS + publishing | **Done (code + local validation)** |
| R5 | Artifacts (S3-compatible) | **Done (code + local validation)** |
| R6 | Browser plane (session plane + ephemeral executor) | **Done (code + local validation)** — no live-browser run yet |
| R7 | Control-plane navigation, health, audit | **Done (code + local validation)** |
| R8 | `scheduled_jobs` → tasks consolidation, Zernio isolation, DB types from migrations | **Code-complete (local validation)**. The cut-over flip and the final removals need live evidence (LIVE_RUNTIME / PRODUCTION_CERTIFICATION) |
| R9 | Campaign attribution, engagement per campaign, lead intake | **Done (code + local validation)** |
| R10 | Provider-neutral publishing contract, receipts, Gateway adapter seam | **Code-complete (local validation)** — `4c82d3d`. Only the concrete Gateway submit transport is blocked (EXTERNAL_CONTRACT) |
| R11 | Roadmap completion: KEK rewrap, manual channels for threads/linkedin/tiktok/youtube, audit keyset cursor, recurring content | **Done (code + local validation)** |

## Completed

### R0 — Audit and architecture
- `docs/architecture/`: CURRENT_ARCHITECTURE, DEAD_CODE_AND_REMOVAL_MANIFEST, TARGET_ARCHITECTURE,
  DOMAIN_MODEL, EXECUTION_MODEL, SECRET_STORE_DESIGN, BROWSER_AUTOMATION_DESIGN, ARTIFACT_STORAGE_DESIGN,
  SECURITY_THREAT_MODEL, MIGRATION_PLAN, IMPLEMENTATION_ROADMAP (+ README index).

### R1 — P0 security
Finding IDs refer to `docs/architecture/CURRENT_ARCHITECTURE.md` §6.

| Finding | Fix | Evidence |
|---|---|---|
| S1 critical: any authenticated user could read/write `scheduled_jobs` (cross-tenant payloads, forged jobs executed by the service-role cron) | 00030 drops the permissive policies, revokes anon/authenticated grants, adds `scheduled_jobs.workspace_id` (backfill + fill trigger); broadcast scheduling moved to the membership-checked `schedule_broadcast_delivery` RPC | `supabase/tests/tenant-security.db.test.ts` (S1) |
| S2 critical: any workspace owner (self sign-up) could import every Gateway account and receive another tenant's webhooks | `gateway_workspace_bindings` + `SOCIAL_GATEWAY_BOUND_WORKSPACE_ID`; `lib/social-gateway/tenancy.ts` enforced in channel sync/connect, conversation sync and the Gateway webhook receiver (fails closed); unique projection index; **client INSERT on `channels` revoked** so the binding cannot be bypassed via PostgREST; sync writes use the service role after owner + binding checks | DB test (S2), `lib/social-gateway/tenancy.test.ts`, `app/api/v1/channels/connect/route.test.ts` |
| S3 high: `goToFlow` / `enrollSequence` / flow loads not scoped by workspace in service-role engine | `executeFlow`, `resumeSession`, `executeEnrollSequence` filter by `workspace_id` | `lib/flow-engine/engine.test.ts` (verified to fail when the filter is removed) |
| S4 high: SSRF via flow HTTP node | `lib/security/safe-fetch.ts` (connect-time DNS validation, private/reserved v4/v6/mapped/NAT64 blocked, no redirects, 10 s / 256 KiB caps, `SAFE_FETCH_ALLOW_HOSTS` opt-in) | `lib/security/safe-fetch.test.ts` (34), engine test (metadata IP refused) |
| S5 high: plaintext secret columns readable by members; full workspace row serialized into the client Sidebar; `webhook_secret` sent to Channels/Growth client views | 00030 column grants; `WORKSPACE_SAFE_COLUMNS` / `CHANNEL_SAFE_COLUMNS`; layout passes `{id,name,slug}` only; client `Channel` types omit `webhook_secret` (typecheck proved the leak) | DB test (S5) |
| S6 high: legacy join tables accepted cross-workspace references | `workspace_consistency_guard` triggers on 7 tables | DB test (S6) |
| S7 medium: cron secret accepted in `?key=` query and compared non-constant-time | `lib/security/cron-auth.ts` (Bearer header only, SHA-256 + `timingSafeEqual`, ≥24 chars, fail closed) | `lib/security/cron-auth.test.ts`, cron route test (query key → 401) |
| S8 medium: API routes used the first membership, ignoring the selected workspace | `lib/workspace-membership.ts` `selectedMembership()` (cookie-aware) in broadcasts, broadcast send, contacts, flows, flow publish/restore; channels routes use `productContext()` | typecheck + existing route tests |
| S9 low: broadcast `scheduled_for` ignored | RPC schedules from `greatest(now(), scheduled_for)`; cron promotes `scheduled → sending` on first job so settlement completes | DB test (S9) |

Other R1 changes:
- **AI Response node** now replies through Agent Social Gateway (`replyToConversation` with
  `flowReplyIdempotencyKey`), replacing the hosted-Zernio send; failures log error class only.
- **Channel DELETE** removes only the local projection; the Zernio disconnect branch is gone. UI and API
  response state that the Gateway account re-imports on sync unless disconnected in the Gateway.
- Delay-node jobs carry `workspace_id` explicitly.
- `.env.example` documents `SOCIAL_GATEWAY_BOUND_WORKSPACE_ID`, `SAFE_FETCH_ALLOW_HOSTS`, cron header rules.
- Test harness `lib/test/pg-harness.ts` (PGlite with Supabase default privileges, `asUser`/`asService`).

### R2 — Durable execution plane (`ff7a02b`)
- **Migration 00031** `execution_plane.sql`: `worker_identities` (sha256 token hashes only), `task_schedules`
  (cron XOR interval, timezone, CAS materialisation), `tasks` (idempotency key per workspace, dependency
  graph within one workspace, approval gate, lease columns, retry policy, dead-letter timestamp),
  `task_events`, `execution_records`. A guard trigger enforces the legal state machine
  (queued/running/waiting/waiting_for_user/retrying/completed/failed/cancelled) and field immutability.
  Service-only RPCs: `claim_tasks` (SKIP LOCKED, mode filter, optional global running cap), `heartbeat_task`,
  `complete_task`, `fail_task` (server-side retry decision → retrying / waiting_for_user / dead letter),
  `defer_task`, `recover_expired_leases`, `materialize_schedule`, `task_log`. Operator RPCs `approve_task`
  (owner), `cancel_task` (member), `retry_task` (owner for dead letters) write `product_activity`.
- **Runtime**: `lib/tasks/*` (runner, retry/backoff with jitter, error classes → retry decisions, 5-field cron
  with timezone, schedules, enqueue, handler registry, maintenance sweep registry), `lib/runtime/budget.ts`
  (zero-cost safeguards: `PAID_COMPUTE_ALLOWED=false`, `MAX_BACKGROUND_WORKERS=1`, `MAX_TASKS_PER_TICK`,
  `TICK_TIME_BUDGET_MS`, `MAX_BROWSER_CONCURRENCY=1`, `BROWSER_IDLE_SHUTDOWN`, upload/retention limits;
  queues wait instead of scaling), `lib/observability/{log,metrics}.ts` (redacting structured JSON logs,
  correlation IDs, counters, span seam).
- **Unified tick** `POST /api/cron/tick` (Bearer `CRON_SECRET`): lease recovery → schedules → internal/api
  tasks → legacy `scheduled_jobs` → sequences → maintenance; each stage isolated; never claims browser tasks.
- **Worker API** `/api/worker/v1` (scoped `zfw_` bearer tokens; workers never hold DB/Vault credentials):
  `claim` (204 when empty, global browser cap), `tasks/:id/{heartbeat,complete,fail,defer,events}` with
  lease checks (409 `lease_lost`).
- **Operator API** `/api/v1/{tasks,tasks/kinds,tasks/:id,tasks/:id/actions,schedules,workers}`; all mutations
  owner-gated where privileged and audited.
- **Jobs UI** `/dashboard/jobs` (Needs attention, Approvals, Active, Dead letters, Completed, All),
  job detail with timeline/executions/actions, Schedules, Workers (owner-only, token shown once).

### R3 — Secret store
- **Migration 00032** `secrets_artifacts_browser_sessions.sql` (renumbered ahead of campaigns; see
  MIGRATION_PLAN): `secrets` (metadata, binding, expiry, last-used, status active/revoked/deleted),
  `secret_versions` (AES-256-GCM ciphertext + wrapped DEK + KEK provider/key/version; **RLS on, no policies,
  no client grants**), `secret_access_events` (append-only audit), plus `artifacts` and `browser_sessions`
  tables used by R5/R6. Guard triggers: immutable identity, no restore after delete/revoke. Widened
  `operator_notifications.entity_type` to platform entities.
- **Crypto** (`lib/secrets/{kek,envelope}.ts`): per-version random DEK + 96-bit IV, AAD
  `zernflow:secret:v1|<ws>|<secret>|<version>` (cross-row / cross-tenant swaps fail authentication).
  `VaultTransitKeyProvider` (production; root key never leaves Vault; https required outside cluster-internal
  hosts; redirects refused; 5 s timeout) and `LocalKeyProvider` (dev/single-node; refused in production unless
  `ZERNFLOW_ALLOW_LOCAL_KEK=true`). DEKs are zeroed after use. Node crypto only — no custom primitives.
- **Store** (`lib/secrets/store.ts`): create, rotate (CAS on `current_version`, older versions marked revoked),
  revoke, delete (crypto-shred ciphertext, tombstone metadata), `resolveSecret` (purpose + identity required;
  worker identities restricted to secrets bound to their current lease; expired/revoked fail closed; every
  attempt audited; last-used updated), `importLegacyAiKey` (encrypts `workspaces.ai_api_key` under binding
  `ai.gateway_key`, then clears the column with compare-and-swap).
- **API** `/api/v1/secrets` (GET metadata for members; POST create, owner), `/api/v1/secrets/:id`
  (GET metadata + access events; POST rotate/revoke; DELETE crypto-shred — owner), `/api/v1/secrets/import-legacy`.
  Values are write-only; no endpoint returns them. 503 with guidance when no KEK provider is configured.
- **UI** `/dashboard/secrets`: write-only create/rotate forms, revoke/delete, expiry badges, legacy import banner,
  recent access log.
- **AI node** now resolves `ai.gateway_key` from the store first, then the legacy column, then the deployment key;
  a configured-but-unusable secret cancels the run (fail closed) instead of silently using another key.
- **Maintenance sweep** `secretExpiry` (registered in `lib/tasks/sweeps.ts`, run by the tick) notifies owners
  of secrets expiring within 7 days or already expired (deduplicated).

### R4 — Campaign OS and publishing
- Migration `00033_campaigns_publishing.sql`:
  - **`campaigns`**: objective, status (draft/planned/active/paused/completed/archived), owner, audience,
    channel_ids (≤ 50, must belong to the workspace), voice, content_plan, utm_defaults, dates, timezone,
    requires_approval (default true), server-managed `results`, notes. Audited; members cannot delete (archive instead).
    `tasks.campaign_id` and `artifacts.campaign_id` FKs; legacy free-text `editorial_drafts.campaign` labels are
    backfilled into campaigns.
  - **Content** (`editorial_drafts`) gains campaign_id, kind, link_url, utm, asset_ids (≤ 20, available artifacts of
    the workspace only), created_by. Changing them resets approval, and they cannot change while any variant is active.
  - **Variants** gain publish_state (draft/scheduled/queued/publishing/published/failed/cancelled), scheduled_at,
    execution_mode (api/browser/manual), idempotency_key, task_id, external_ref/url (https), published_at,
    last_error, attempt_count. Clients cannot write publish fields; transitions are enforced in the database;
    published is terminal.
  - RPCs: `schedule_content_item` (approval gate: campaign approval rule, else owner-or-approved; rejects times
    > 5 min in the past; one idempotent `content.publish` durable task per variant; manual → `human` mode),
    `unschedule_content_item`, `confirm_manual_publication`.
- `lib/publishing/`:
  - `capabilities.ts`: platform profiles (text limits, media rules, link rendering) and the adapter registries.
    API mode exists only when an `ApiPublishAdapter` is registered (none are, pending the Gateway publishing contract in
    R10); browser mode only when a browser publisher is registered (R6); manual is always available. The UI and API
    show unavailable routes with the reason and never claim them.
  - `utm.ts` (tracked links; explicit URL params win; draft overrides campaign), `compose.ts` (composition, limits,
    `summarizePublishState` incl. `partially_published`), `service.ts` (`loadPublishContext`, `planSchedule`,
    `contentPublishHandler`, `settleRemotePublish`), `sweeps.ts`, `campaign-input.ts`, `calendar.ts`.
  - Handler `content.publish`: skips stale tasks (idempotency key mismatch), refuses API mode without an adapter
    (`unsupported_capability` → operator action), marks variants queued/failed on errors and rethrows so the task
    retry policy decides.
  - Worker complete/fail routes call `settleRemotePublish` (best-effort; the reconcile sweep repairs gaps).
  - Sweeps: `publishReconcile` (variant state follows task state: missing/failed → failed, running → publishing,
    cancelled in Jobs → cancelled, completed → published) and `manualPublishDue` (flags due manual publications
    for operator action, notifies owners once per task).
- API: `/api/v1/campaigns` (GET/POST), `/api/v1/campaigns/:id` (GET/PATCH with optimistic version; status flow;
  archive is owner-only), `/api/v1/content/:id/schedule` (capability check → mode resolution → RPC as the user;
  blocked variants are reported, never silently dropped; `dryRun`, `allowPartial`), `/api/v1/content/:id/unschedule`,
  `/api/v1/content/variants/:id/confirm`, `/api/v1/publishing/capabilities`. Content create/update continues through
  the configuration API with the new fields validated.
- UI: `/dashboard/campaigns` (+ detail with results tally, content, jobs, status actions),
  `/dashboard/content` (filters by campaign/status, create), `/dashboard/content/:id` (per-channel preview with
  tracked link, platform issues, review/approve, schedule panel with per-variant route, unschedule, manual confirm,
  activity), `/dashboard/calendar` (month grid in the browser's timezone). The generic configuration pages for
  editorial drafts redirect to Content; the sidebar "Editorial" entry is replaced by Campaigns, Content and Calendar
  (the full navigation rework is R7).

### R7 — Control plane: navigation, dashboard, system health, audit log
- `components/navigation.ts`: grouped information architecture — Dashboard · Plan (Campaigns, Content, Calendar,
  Assets) · Engage (Inbox, Automations, Sequences, Broadcasts, Growth tools, Canned replies, Knowledge) · Customers
  (Contacts, Companies & deals, Work items) · Operate (Jobs, Connected accounts, Notifications) · Analytics
  (Analytics, Team performance) · Admin (Secrets, Team, System health, Audit log, Email identities, Settings).
  Most-specific active match, `aria-current`, owner-only entries hidden for members. A test asserts every entry
  resolves to an existing page (no dead links). Browser sessions was added in R6 (no stub link in the meantime).
  "Flows" is labelled Automations, "Channels" Connected accounts, "Operator analytics" Team performance — routes unchanged.
- `/dashboard` is now an operator home (active campaigns, posts in the next 7 days, jobs needing a human, failed
  posts, open conversations, unread notifications, up-next list, needs-you list) instead of redirecting to Flows.
- Migration `00034_system_heartbeats.sql`: deployment heartbeat table (non-sensitive status only; signed-in read,
  service write) and `record_heartbeat` (service-only; keeps `last_ok_at` across failures). The tick records its
  status, duration and failed stage names; a heartbeat failure never fails the tick.
- `/dashboard/system-health` (owners): scheduler tick freshness, job backlog/interventions, external worker
  check-ins, Gateway configuration and last health check, secret store KEK provider (warns on local KEK in
  production), artifact storage usage vs cap, publishing failures/manual due, zero-cost guardrail drift. Rules live
  in `lib/health/assess.ts` (pure, tested); configuration is reported as present/missing only. Backlog advice
  explicitly says queues drain at the configured rate — no scaling suggestion.
- `/dashboard/audit`: unified, cursor-paged log of record activity (`product_activity`) and secret access events,
  filterable by source and record type; changed *field names* only (values can contain personal data); actors
  resolved to member labels via `lib/workspace-directory.ts` (members of the current workspace only).

### R9 — Campaign attribution (UTM → lead source → campaign)
- Migration `00036_campaign_attribution.sql`:
  - `contact_touchpoints` (comment / dm / form / link / manual / import; campaign, variant, channel, UTM,
    landing URL, note, `occurred_at`; per-workspace `dedupe_key`; composite FKs so every reference stays in the
    touchpoint's workspace). Members read; members insert **manual** touchpoints only, as themselves, without a
    dedupe key; owners delete; everything else is service-written.
  - `contacts.first_touch_source / first_touch_at / last_touch_at / first_campaign_id / last_campaign_id`,
    maintained by a definer trigger on touchpoint insert. Guard triggers stop clients forging these on
    insert or update. The editable CRM lead source stays in `customer_profiles.source`, and the UI shows it first.
  - `campaign_engagement(workspace, since)` is security invoker, so RLS scopes it. Per campaign it returns:
    comments and unique commenters on the campaign's published posts (`comment_logs` joined to
    `editorial_variants.external_ref`), attributed touchpoints/contacts, and first-touch leads.
  - `lead_intake_tokens`: SHA-256 only; owners read metadata and the hash column is not granted; hash and
    workspace immutable; revocation final.
- `lib/attribution/service.ts`:
  - `recordTouchpoint` is idempotent.
  - `campaignForPost` maps provider post → variant → campaign.
  - `resolveCampaignFromUtm` checks the campaign's explicit `utm_defaults.utm_campaign` first, then the name slug
    (the same slug tracked links use).
  - `recordCommentTouchpoint` is best-effort and wired into the comment processor once the commenter's contact is
    known. It runs once per comment.
- `lib/attribution/intake.ts` + `POST /api/intake/v1/leads`:
  - Server-to-server lead capture with a Bearer `zfl_` token.
  - The body is capped at 8 KiB and each token has an in-process rate limit (`LEAD_INTAKE_RATE_PER_MINUTE`, default 60).
  - Matches contacts by email case-insensitively (LIKE wildcards escaped) or creates one (audited).
  - Reads UTM from the body or the landing URL; `Idempotency-Key` makes retries safe.
  - Attributes to the token's default campaign or by `utm_campaign`.
- `lib/security/rate-limit.ts`: fixed-window limiter. It is per instance, which suits the single always-on
  service; no paid shared store.
- Owner API: `/api/v1/lead-intake` (list; create returns the plaintext token once) and `/:id/revoke`.
- Member API: `/api/v1/contacts/:id/touchpoints` (list and manual create through the caller's RLS client).
- UI:
  - Customer 360 gets an Attribution panel: lead source, first/latest campaign, touchpoint timeline and a manual
    attribution form.
  - Campaign detail gets "Engagement and leads" (comments, commenters, attributed contacts, first-touch leads,
    recent attributed contacts).
  - Campaign cards show 30-day comments and new leads.
  - The Campaigns page gets a Lead intake section for owners (instructions, token creation, revoke).
  - Analytics gets a "Campaign attribution (last 30 days)" table inside the existing scroll area.
- `lib/test/memory-supabase.ts` gained `ilike` (LIKE semantics with escapes).

### R8 — Legacy queue consolidation, Zernio isolation, schema-derived types

**Legacy `scheduled_jobs` → durable tasks** (full procedure in `docs/architecture/LEGACY_JOBS_MIGRATION.md`):
- Migration `00037_legacy_jobs_to_tasks.sql`:
  - `legacy_queue_routes` is a service-only, per-type switch that defaults to `scheduled_jobs`, so applying the migration changes nothing.
  - `schedule_flow_resume` is the new producer for delay nodes. It validates tenancy through `flows`.
  - `schedule_broadcast_delivery` and `claim_social_gateway_webhook` keep their signatures and contracts, and branch on the switch.
  - Every unit is enqueued at most once across both queues.
  - `legacy_queue_status()` reports cut-over evidence.
- `lib/jobs/legacy-work.ts` holds the unit-of-work logic, lifted from `/api/cron/jobs`. It is shared by the legacy drain and the new task handlers `flow.resume`, `broadcast.deliver` and `gateway.event`, so parity comes from running the same code.
  - The one behavioural change is intended: the "session parked by another resume" check now looks in both queues.
- The task handlers mirror legacy retry semantics:
  - 3 attempts; every error retries;
  - Gateway-pending and session-recheck become deferrals that don't consume an attempt;
  - the final attempt or a `SessionCancelError` settles first, then dead-letters.
  - Gateway operation progress is carried in `current_step`, because task input is immutable.
- Runner: `TaskError(..., { terminal: true })` forces `give_up`.
- Sweep `legacyTaskSettle` settles legacy-kind tasks that were dead-lettered without passing through the handler (e.g. an expired lease).
- The flow engine's delay node now calls `scheduleFlowResume`. It falls back to the pre-R8 direct insert if the RPC is missing or fails, which removes any deploy-ordering hazard.
- System health gains a **Legacy job queue** check: the routing per type, plus this workspace's pending legacy rows. It warns only if the legacy drain falls behind.

**Zernio isolation** (manifest §1–§3):
- Removed the unreachable Zernio inbox backfill (no caller since the base commit; evidence in the manifest). The live `upsertContactForSender` moved to `lib/contacts/sender.ts` and now has direct tests.
- `lib/legacy/zernio-boundary.test.ts` freezes the remaining Zernio importers, so the stage-2 deletion set cannot grow.
- The ungated late webhook now counts deliveries (`legacy_zernio_webhook_total`) and supports a reversible brownout, `LEGACY_ZERNIO_WEBHOOK=reject` (410).
- The landing page still linked to the upstream repository, showed the vendor badge and used competitor comparison copy, despite the earlier manifest note. It was rewritten ZernFlow-native, the source link is now `NEXT_PUBLIC_SOURCE_URL`, and the metadata was updated.
- The comment-rule post-ID help text no longer refers to Zernio.

**Database types from the migration source of truth:**
- `lib/test/db-typegen.ts` introspects the PGlite-migrated schema and emits `lib/types/database.generated.ts` (`npm run db:types`).
- `supabase/tests/db-types.test.ts` fails when the generated file is stale.
- `lib/types/database-drift.ts` fails `tsc` when the hand-maintained contract references a table, column or function the migrations don't create, or types a nullable column as non-null.
  - It carries 5 reviewed historical exceptions: defaulted timestamps without NOT NULL.
  - A stale exception also fails.
  - No other drift was found.

### R6 — Browser plane (managed sessions + ephemeral executor)
Scope decision: R6 ships the **session plane** (encrypted sessions, read-only health checks, human hand-off,
evidence, revocation) and the executor. It does **not** ship browser publishing: no adapter's `publish_post`
is verified, so the capability gate keeps browser publishing unavailable and the product does not claim it.
- `lib/browser/` (self-contained, shared by app and worker): read-only `BrowserSurface` contract
  (navigate, currentUrl, count, cookieNames, screenshot — no typing, clicking or credential entry exists in the
  contract), `checkSession` policy (challenge → MFA → signed-out → signed-in; screenshot on every non-healthy
  state), `STATE_OUTCOME` mapping to task error classes, network guard (`isBlockedRequest`: non-http(s),
  private/loopback/link-local/metadata/CGNAT/ULA incl. IPv4-mapped and IPv4-compatible IPv6 hex forms;
  `isAllowedNavigation`: https + adapter host allowlist), storage-state parser (size cap, adapter-domain-only
  cookies, signed-in cookie required), registry + `resolveExecutor` (API → Gateway → browser; experimental
  capabilities need an explicit opt-in). Five adapters (Instagram, Facebook, TikTok, LinkedIn, X): selectors
  and signals live only in `lib/browser/adapters/*`; `session_check` = experimental, `publish_post` = unsupported.
- Migration `00035_browser_plane.sql`: `unverified` status, `allow_experimental` (CHECK: needs attestation),
  `last_check_task_id`; guard trigger makes `platform` immutable and blocks new state on revoked sessions;
  `worker_identities.capabilities` (bounded jsonb) + `version` (owner-readable, token hash still excluded).
- `lib/browser-sessions/service.ts`: create, attest (owner, audited), import (encrypted into the R3 secret store
  as `browser_session_state`; re-import rotates; falls back to a fresh secret if the old one was revoked; supersedes
  checks parked on the old state), `requestSessionCheck` (idempotent per 10 min, or per day for scheduled checks;
  browser mode; retry 2× with 5–30 min backoff), revoke (crypto-shreds the state, clears the opt-in, cancels pending
  browser tasks), `sessionForLeasedTask` (decrypts only for the lease holder of a browser task of the same
  workspace, re-checks attestation/opt-in, audited as a worker secret resolve), `reportSessionState` (healthy may
  rotate cookies after re-validation; human states notify owners once per state per day).
- `lib/browser-sessions/sweep.ts` (maintenance sweep `browserSessions`): expires sessions past cookie expiry
  (owners notified) and queues at most 20 scheduled checks for attested, opted-in sessions older than
  `BROWSER_SESSION_CHECK_HOURS` (default 24; 0 disables).
- `lib/product/notify.ts`: shared owner notification helper (deduped upsert into `operator_notifications`).
- Worker API: `GET/POST /api/worker/v1/tasks/:id/session` (browser-mode identity + lease + browser task only,
  `no-store`); claim accepts `{capabilities, version}` (sanitised) and records them on the worker identity.
- Owner/member API: `/api/v1/browser-sessions` (list + platform catalog; create: owner), `/:id/state` (raw
  Playwright storage-state import, owner; auto-queues a check when allowed), `/:id/attest` (owner), `/:id/check`
  (members), `/:id/revoke` (owner). Visibility is checked with the caller's RLS client before service writes.
- UI: `/dashboard/browser-sessions` (Operate → Browser sessions): capability matrix with verification levels,
  local `npx playwright codegen --save-storage=state.json <url>` instructions, import, attestation + experimental
  opt-in, check now, revoke, status explanations (the product never solves challenges), executor check-ins.
- `workers/browser-executor/` (separate CJS package, `playwright-core@1.63.0` pinned, Dockerfile on
  `mcr.microsoft.com/playwright:v1.63.0-noble`, BuildKit allowlist `Dockerfile.dockerignore`): claim → session →
  fresh Chromium + context per task (no persistent profile, downloads off, service workers blocked, popups and
  dialogs dismissed, private-network requests aborted, top-level navigation confined to the adapter's hosts) →
  `checkSession` → screenshot artifacts (best effort) → report → complete/fail. Heartbeats every 60 s; unknown
  task kinds fail `unsupported_capability`; unusable sessions fail `policy_denied`; crashes fail `transient` with
  query-free messages; exits when idle (`BROWSER_IDLE_SHUTDOWN`) or at `BROWSER_JOB_MAX_MS`. Worker token only
  sent to `ZERNFLOW_URL` (https unless localhost, redirects refused); uploads go to presigned URLs without it.
- CI: installs, audits and builds the worker package. Root tsconfig excludes the Playwright-dependent files.

### R5 — Artifact storage (S3-compatible, vendor-neutral)
- `lib/storage/`: `ObjectStore` interface; `S3ObjectStore` (AWS SDK v3, any S3-compatible endpoint; https
  enforced outside cluster-internal hosts; portable checksum mode); `MemoryObjectStore` (tests).
  Presigned PUTs sign `content-type`, `content-length`, `x-amz-checksum-sha256` and SSE headers, so the
  provider rejects bytes that differ from what was declared. Presigned GETs force content type and disposition;
  TTL clamped to 30 s–1 h.
- `lib/artifacts/policy.ts`: per-kind MIME allowlist (no SVG/HTML), magic-byte verification (markup disguised
  as text is rejected), file-name sanitising (metadata only, never used in keys), safe `Content-Disposition`.
- `lib/artifacts/service.ts`: `createUpload` (kind allowed for caller, size ≤ `MAX_UPLOAD_SIZE_BYTES`,
  per-workspace cap `MAX_WORKSPACE_STORAGE_BYTES`, key `ws/<ws>/<kind>/<yyyy>/<mm>/<uuid>` generated server-side,
  screenshots/traces get `retention_until`), `completeUpload` (HEAD size/type/checksum + first 4 KiB signature →
  `available` or `quarantined`, audited), `signedDownload`, `deleteArtifact` (audited), `sweepArtifacts`
  (expired, quarantined > 7 d, abandoned uploads > 24 h; bounded) registered as maintenance sweep
  `artifactRetention` (skipped when storage is not configured).
- API: `/api/v1/assets` (list, presign for members), `/api/v1/assets/:id` (metadata + signed URL; delete by
  owner or uploader), `/api/v1/assets/:id/complete`, `/api/v1/assets/:id/download` (302 to a 60 s URL).
  Worker API: `/api/worker/v1/tasks/:id/artifacts` and `.../artifacts/:artifactId/complete` (lease-bound;
  screenshot/trace/report/export only; artifact tied to the task and worker).
- UI: `/dashboard/assets` (direct-to-storage upload with browser-side SHA-256, kind filters, image previews via
  5-minute signed URLs, usage vs cap, delete); job detail lists the job's artifacts.
- `artifacts` added to typed tables; the `.from("artifacts" as "tasks")` cast in execution summaries removed.
- New deps (exact pins): `@aws-sdk/client-s3@3.1140.0`, `@aws-sdk/s3-request-presigner@3.1140.0`
  (`npm audit --omit=dev`: 0 vulnerabilities).

### R10 — Provider-neutral publishing contract (`4c82d3d`)
- `lib/publishing/contract.ts`: `PublishingProvider` / `PublishOutcome` (published, accepted, partial, failed,
  unknown), capability levels, a provider registry, outcome validation, and failure classification that accounts
  for ambiguous outcomes. R4 `ApiPublishAdapter` is wrapped for compatibility.
- `lib/publishing/engine.ts`: a receipt is written *before* every provider call. Accepted operations are polled.
  Ambiguous attempts are never resubmitted automatically. Partial success is terminal. The engine recovers from
  crashes, retries by failure class, and only makes legal variant transitions.
- `lib/publishing/gateway-provider.ts`: maps `GatewayOperation` (`GET /v1/operations/{id}`, already part of the
  Gateway client) to outcomes. It exposes a narrow `GatewayPublishingTransport` seam. **Submission is not
  implemented:** the Gateway exposes no publish endpoint, and none was invented.
- 00038: `publish_receipts` (state machine; members read, service writes). `confirm_manual_publication` records
  receipts, and `resolve_publication` handles operator reconciliation.
- UI: attempt history and a reconcile form. API: `POST /api/v1/content/variants/{id}/reconcile`.
- Design, the outcome table, what the Gateway still needs to publish, and rollback:
  `docs/architecture/PUBLISHING_CONTRACT.md`.

### R11 — Roadmap completion (items previously deferred as repo-side work)
- **KEK rotation (R3 follow-up).** `lib/secrets/kek.ts` keeps the previous local KEK available
  (`ZERNFLOW_LOCAL_KEK_PREVIOUS[_ID]`) and calls Vault `transit/rewrap`. `lib/secrets/rewrap.ts` adds the
  `secrets.rewrap` task: batched, keyset-deferred, compare-and-swap on `wrapped_dek`, skips revoked versions, and
  audits `action=rewrap`. Runbook: `SECRET_STORE_DESIGN.md` §5.1.
- **Manual-only channels for platforms without a connector (R4 follow-up).** 00039 widens the `channels.platform`
  CHECK to threads/linkedin/tiktok/youtube. These platforms are allowed **only** as manual channels, with account
  ref `manual:<platform>:<handle>` enforced by a DB CHECK. They carry no credentials and have no inbox or
  automation; publishing is manual with reminders and confirm-by-link.
  - `POST /api/v1/channels/manual` (owner only). Writes go through the service client after the app-level owner
    check; the 00030 channel grants stay revoked.
  - Channels page has an owner form.
  - Gateway channel sync never matches or deactivates manual channels.
  - Manual channels for Gateway platforms are rejected on purpose: they would show up in inbox and automation
    pickers without working.
- **Audit log keyset cursor (R7 follow-up).** The cursor is `before=<raw created_at>|<id>` and the pagination
  filter is `(created_at, id) <`. It keeps Postgres's microsecond timestamp: the old `toISOString()` cursor
  truncated it to milliseconds and could skip events. Parsing is strict, so a cursor cannot inject filters; a
  legacy bare timestamp is still accepted. 00039 adds `(workspace_id, created_at desc, id desc)` indexes on
  `product_activity` and `secret_access_events`.
- **Recurring content (R4 follow-up).** Adds the `content.recur` task (schedulable, internal) and a Repeat control
  on the content page (owner only; daily, weekly or monthly at a local time, via the generic
  `/api/v1/schedules`).
  - Each occurrence creates a **draft** copy with the body, kind, link, UTM, still-available assets, campaign and
    active-channel variants. Owners get a notification.
  - It never schedules or publishes anything.
  - It is idempotent per occurrence through the unique `editorial_drafts.source_task_id` (00039).
  - It skips completed or archived campaigns, and fails terminally if the source content was deleted.

## Changed files (R1)
- Migration: `supabase/migrations/00030_tenant_security_hardening.sql`
- New: `lib/security/{safe-fetch,cron-auth}.ts` (+tests), `lib/social-gateway/tenancy.ts` (+test),
  `lib/workspace-membership.ts`, `lib/test/pg-harness.ts`, `supabase/tests/tenant-security.db.test.ts`,
  `lib/flow-engine/engine.test.ts`
- Modified: flow engine + AI node, `lib/scheduler.ts`, `lib/workspace.ts`, `lib/types/database.ts`,
  dashboard layout/sidebar, channels page/view, growth page/view, cron jobs/sequences routes, channels
  routes (list/delete/sync/connect), conversations sync, Gateway webhook, broadcasts/contacts/flows routes.

## Removed (with evidence in DEAD_CODE_AND_REMOVAL_MANIFEST.md)
- `lib/flow-engine/index.ts` — barrel with zero importers (grep + knip).
- `pg` devDependency — no imports anywhere (tests use PGlite).
- `scheduleJob()` in `lib/scheduler.ts` — zero callers; client-side job inserts are now forbidden anyway.
- Zernio branches in AI node and channel DELETE.
- R4: `lib/publishing/contracts.ts` (+ test) — `summarizePublishing` and the `Publishing*` types had no importers
  outside their own test (grep across `app/ components/ lib/`); superseded by `lib/publishing/compose.ts` and
  `capabilities.ts`.
- R4: editorial-variant rendering in the generic configuration detail page — the route now redirects to Content,
  which keeps the variant editor and the activity trail.

## Tests / validation (R1, local)
- `npm run typecheck` — pass
- `npm run lint` — 0 errors, 44 warnings (baseline 44; no new warnings)
- `npx vitest run` — 49 files / 342 tests pass (baseline 44 / 283)
- `npm run build` with CI dummy env — pass
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities
- Migration history 00001–00030 executed in PGlite (both harnesses)
- Local Node is 22; CI (Node 24 / npm 11) is authoritative.

## Tests / validation (R2 + R3, local)
- `npx tsc --noEmit` — pass; `npm run lint` — 0 errors, 44 warnings (unchanged baseline)
- `npx vitest run` — 61 files / 408 tests pass
  - R2: `supabase/tests/execution-plane.db.test.ts` (12: state machine, tenant isolation, claim/lease/fail/defer,
    schedule CAS, operator RPC authz), cron, retry/errors, runner, observability/budget, worker tokens,
    worker API (auth, mode refusal, lease loss), tick stage isolation.
  - R3: `supabase/tests/secrets-artifacts.db.test.ts` (6: ciphertext unreadable by owners, no client writes,
    cross-workspace FK rejection, name uniqueness, artifact key prefix, browser-session revocation, notification
    types), `lib/secrets/secrets.test.ts` (12: AEAD binding/tamper/wrong KEK, fresh DEK/IV, size limits,
    production refusal of local KEK, Vault wrap/unwrap + failure, full lifecycle with audit trail, tenant
    isolation, worker lease scoping, expiry, rollback on partial write, legacy import),
    `app/api/v1/secrets/secrets-api.test.ts` (6: value never returned, owner-only mutations, validation, 404 for
    foreign ids, rotate/revoke/delete, 503 unconfigured), `lib/secrets/expiry-sweep.test.ts`.
- `npm run build` with CI dummy env — pass (includes R2 and R3 routes).

## Tests / validation (R5, local)
- tsc pass; lint 0 errors / 44 warnings; `npx vitest run` — 64 files / 425 tests pass; build pass; audit 0.
- New: `lib/artifacts/artifacts.test.ts` (9: allowlist, magic bytes, file-name sanitising, key layout,
  presign→verify→download, quarantine, kind/size/quota limits, cross-tenant refusal, retention sweep),
  `lib/storage/s3.test.ts` (3: config validation, signed-header binding on real SDK presigns, forced
  download headers), `app/api/v1/assets/assets-api.test.ts` (5: full flow, refusals, 503 unconfigured,
  delete authz, worker lease binding, worker kind restriction, 401/409).

## Tests / validation (R4, local)
- tsc pass; lint 0 errors / 44 warnings; `npx vitest run` — 66 files / 450 tests pass; build pass; audit 0.
- New: `supabase/tests/campaigns-publishing.db.test.ts` (9: campaign channel ownership, server-managed results,
  member delete refusal, forged variant inserts forced to draft, client publish-field writes refused, transition
  guard, approval gate, idempotent scheduling, unschedule/confirm, asset ownership),
  `lib/publishing/publishing.test.ts` (13: capability claims, UTM, composition/limits, aggregate state, campaign
  input, planning, handler stale/unsupported/adapter/retry paths, remote settlement, reconcile, manual reminders,
  calendar helpers), `app/api/v1/campaigns/campaigns-api.test.ts` (5), config-contract cases for the new fields.

## Tests / validation (R7, local)
- tsc pass; lint 0 errors / 44 warnings; `npx vitest run` — 69 files / 463 tests pass; build pass; audit 0.
- New: `supabase/tests/system-heartbeats.db.test.ts` (3: last_ok_at retention, read-only for users and no RPC
  access, input constraints), `lib/health/assess.test.ts` (7: health rules, audit merge, value redaction),
  `components/navigation.test.ts` (3: active matching, no dead links, uniqueness).

## Tests / validation (R9, local)
- tsc pass; lint 0 errors / 44 warnings; `npx vitest run`: 77 files / 543 tests pass; build pass; audit 0.
- New: `supabase/tests/campaign-attribution.db.test.ts` (5 tests):
  - first/last touch maintenance, including a back-dated touch
  - cross-tenant FK rejection and dedupe
  - member manual-only insert as self, forging blocked, member delete denied
  - tenant isolation
  - `campaign_engagement` counts, and RLS stops another tenant reading them
  - intake token grants, immutability and final revocation
- New: `lib/attribution/attribution.test.ts` (8 tests):
  - lead parsing and validation
  - UTM → campaign resolution precedence and workspace scoping
  - comment → campaign mapping, once per comment
  - token authentication and revocation
  - case-insensitive matching with escaped wildcards
  - intake route 401 / 201 / idempotent replay / 400 / 413
  - rate limiter

## Tests / validation (R8, local)
- `supabase/tests/legacy-jobs-routing.db.test.ts` (12 tests):
  - the switch defaults and is service-only; the target CHECK is enforced;
  - resume routing, idempotency and tenancy;
  - broadcast routing and at-most-once across queues;
  - Gateway claim routing, re-queue after failure and fallback for an orphan channel;
  - `legacy_queue_status`.
- `lib/jobs/legacy-task-handlers.test.ts` (12 tests):
  - registry, and the operation-step round trip;
  - broadcast defer → getOperation → sent, with the same idempotency key;
  - retry before the last attempt; settle and dead-letter on the last one;
  - resume parked by a task, parked by a legacy job, deferred recheck, stranded-session cancel, normal resume;
  - the settle sweep, which is idempotent.
- Other new tests:
  - `lib/jobs/schedule-resume.test.ts`: RPC routing and the legacy fallback.
  - Runner: a terminal error means `give_up`.
  - Health: legacy queue check.
  - `lib/contacts/sender.test.ts` (3).
  - `lib/legacy/zernio-boundary.test.ts` (2).
  - Late webhook brownout (2).
  - `supabase/tests/db-types.test.ts`: the generated types are fresh.
- Removed: 11 backfill tests (with the unreachable backfill).

## Tests / validation (R11 + R10, local — final gate for this branch)
- CI dummy env. `tsc` pass. `npm run lint`: 0 errors, 44 warnings (existing). `npx vitest run`: 90 files /
  618 tests pass. `npm run build` pass. `npm audit --omit=dev --audit-level=high` (app and worker): 0.
  Worker `tsc` pass. Full `npm audit` also reports 2 moderate advisories in the dev-only
  `@vitest/mocker` (test tooling, not shipped).
- New tests:
  - `lib/secrets/rewrap.test.ts` (7).
  - `supabase/tests/manual-channels-rewrap.db.test.ts` (3): platform/manual-ref CHECKs, rewrap audit action,
    recurring-copy uniqueness, tenant FK and set-null.
  - `app/api/v1/channels/manual/route.test.ts` (2).
  - Manual-channel parsing in `gateway-provider.test.ts` (6).
  - Keyset and cursor-injection cases in `lib/health/assess.test.ts`.
  - `lib/publishing/recurring.test.ts` (5).
- `npm run db:types` regenerated `lib/types/database.generated.ts` from migrations through 00039.

## Tests / validation (R6, local)
- tsc pass; lint 0 errors / 44 warnings; `npx vitest run` — 75 files / 530 tests pass; build pass;
  `npm audit --omit=dev` 0 (app and worker); worker `tsc` build pass.
- New: `lib/browser/browser.test.ts` (43: contract minimality via a strict proxy surface, no-bypass behaviour,
  detection order per adapter against DOM fixtures, `resolveExecutor`, network guard incl. mapped IPv6 and
  metadata hosts, storage-state validation), `supabase/tests/browser-plane.db.test.ts` (4: status/attestation
  constraints, platform immutability, revoked sessions cannot receive state, worker capability bounds + owner-only
  reads), `lib/browser-sessions/browser-sessions.test.ts` (8: encryption at rest, foreign-domain rejection,
  gating, idempotent checks, lease/workspace-bound release, revoke shreds + cancels, reports/notifications/
  rotation, sweep), `app/api/worker/v1/browser-session-api.test.ts` (4: owner API flow, member denial, worker
  endpoint lease/mode/token checks, capability sanitising), `workers/browser-executor/src/{client,loop}.test.ts`
  (8: token confinement, redirects refused, idle/time-budget exits, human hand-off, crash classification).
- **Not run:** a real Chromium session check. The Playwright browser CDN is unreachable from this sandbox.

## Remaining work (every item labelled)

Labels: `CODE` = repo-side work anyone can do here; `LIVE_RUNTIME` = needs observation of the deployed system;
`SECRET/CONFIG` = needs an operator-held credential or setting; `EXTERNAL_CONTRACT` = needs another system's
published interface; `PRODUCTION_CERTIFICATION` = a live acceptance run before the item can be called production-ready.

### Deliberate product decisions (not blockers)
These were left out on purpose. They are recorded so they are not mistaken for unfinished work.
- R9 link-click tracking: anonymous clicks cannot be tied to contacts, and the site's own analytics already
  receive the UTMs.
- R9 automatic DM touchpoints: DMs carry no post reference, and a DM started by a comment automation is already
  attributed through the comment.
- R9 attribution starts from 00036: existing contacts are not backfilled, because no historical signal ties them
  to campaigns.
- R6 MFA live view: users complete MFA locally and re-import the session. No CAPTCHA/MFA bypass, by design.

### CODE (repo-side, not needed for the current release)
- R6: `claim_tasks` kind filtering, so a browser worker never leases a kind it cannot run. Today such tasks fail
  safely with `unsupported_capability`. This is only useful once a second browser-capable kind exists.
- R6: DNS-rebinding protection in the browser request guard. Hostnames that resolve to private addresses are
  not blocked by hostname inspection alone; the container network is the backstop.
- R9: a shared intake rate limit (today per instance). With one always-on service (Northflank Sandbox) this is
  exact; it only matters if Service 1 is ever replicated.

### EXTERNAL_CONTRACT
- R10: the concrete `GatewayPublishingTransport` (one file) needs the Agent Social Gateway to publish its
  submission contract. The five required facts are in `PUBLISHING_CONTRACT.md` §5. API publishing for connected
  channels stays off until then; manual publishing works now.
- The Agent Social Gateway canonical contract repository was not accessible from this environment. The adapter
  uses only the operations the existing ZernFlow client already calls.
- R6: browser *publishing* and any other write action need a verified per-platform adapter and a check that the
  platform's terms allow it. The browser contract is deliberately read-only (session checks) today.

### LIVE_RUNTIME
- R8 cut-over: flip `legacy_queue_routes` one type at a time and observe (`LEGACY_JOBS_MIGRATION.md` §3).
- Zernio stage 2 evidence (manifest §3): `ENABLE_LEGACY_ZERNIO` is unset everywhere; 30 days with zero `zernio`
  `webhook_events` and zero accepted metrics; at least 14 days of `LEGACY_ZERNIO_WEBHOOK=reject` brownout.
- `workspaces.ai_api_key` drop: `select count(*) from workspaces where ai_api_key is not null` must return 0
  (after owners run "Encrypt and import").
- The 5 `KnownNullabilityExceptions`: confirm no NULLs in live data before a backfill + `SET NOT NULL` migration.
- Live-schema drift: compare `supabase gen types` on the real project with `lib/types/database.generated.ts`.
- `vercel.json` retirement: confirm no Vercel project still deploys this repo. Then delete the file; its two
  per-minute crons are superseded by `/api/cron/tick`.
- R6 traces: decide on redaction and retention on a real session before enabling Playwright tracing. Traces can
  capture personal data.

### SECRET/CONFIG
- Vault: add `transit/rewrap/<key>` to the ZernFlow policy (needed by `secrets.rewrap`), alongside encrypt and
  decrypt.
- Northflank: cron Job 2 → `/api/cron/tick`; Job 1 browser executor with its worker token; Service 1 env
  (`SECRET_STORE_*`, `VAULT_*`, `ARTIFACT_S3_*`, zero-cost guards).
- `SOCIAL_GATEWAY_BOUND_WORKSPACE_ID` if the 00030 backfill could not bind exactly one workspace.

### PRODUCTION_CERTIFICATION
- Removals that follow the evidence above: the legacy `scheduled_jobs` drain and fallback insert
  (`LEGACY_JOBS_MIGRATION.md` §4, 5 proofs); Zernio stage 2 (`lib/zernio-*`, `/api/webhooks/late`,
  `@zernio/node`, `late_api_key_encrypted`, `workspaces.webhook_secret`, `channels.webhook_secret`).
- A live Supabase + Gateway acceptance run (no credentials in this environment).
- See "Production certification still required" below for the per-slice live checks.

## Assumptions
- Single production workspace projects the deployment Gateway (00030 backfill binds it automatically when
  exactly one workspace already has channels; otherwise operator sets `SOCIAL_GATEWAY_BOUND_WORKSPACE_ID`).
- Production `CRON_SECRET` is ≥ 24 characters (documented since before this program); shorter secrets now fail closed.

## Operator actions required at deploy (R1)
1. Apply migration 00030, then deploy the app from the same commit.
2. Run the verification queries in `docs/architecture/MIGRATION_PLAN.md`; confirm a binding row exists or
   set `SOCIAL_GATEWAY_BOUND_WORKSPACE_ID`.
3. Confirm schedulers send `Authorization: Bearer $CRON_SECRET` (not `?key=`), and the secret is ≥ 24 chars.
4. If flows call internal services, list their exact hostnames in `SAFE_FETCH_ALLOW_HOSTS`.
5. Recommended: disable public sign-up in Supabase Auth for single-operator deployments.

## Operator actions required at deploy (R2 + R3)
1. Apply 00031 and 00032 in order before deploying the matching app build.
2. Point the Northflank maintenance cron job (Job 2) at `POST /api/cron/tick` with
   `Authorization: Bearer $CRON_SECRET` every 1–5 minutes. `/api/cron/jobs` still works but the tick supersedes it.
3. Issue a worker token under Jobs → Workers for the browser executor job (Job 1) and set it as
   `ZERNFLOW_WORKER_TOKEN` there (used from R6).
4. Secret store: create a Vault Transit key (`vault write -f transit/keys/zernflow-secrets`), a policy allowing
   only `transit/encrypt/zernflow-secrets`, `transit/decrypt/zernflow-secrets` and (for KEK rotation, R11)
   `transit/rewrap/zernflow-secrets`, and a token for it; set
   `SECRET_STORE_KEK_PROVIDER=vault-transit`, `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_TRANSIT_KEY` on Service 1.
5. Owners: open Secrets and run "Encrypt and import" if the legacy AI key banner appears.
6. Artifacts (R5): create a **private** bucket on a free S3-compatible tier (or MinIO/Garage on K3s), set
   `ARTIFACT_S3_*`, add a CORS rule allowing `PUT` from the app origin with headers `content-type`,
   `x-amz-checksum-sha256`, `x-amz-server-side-encryption`; recommended lifecycle rule: abort incomplete
   multipart uploads after 1 day. If the provider rejects the SSE or checksum header, set
   `ARTIFACT_S3_SSE=none` / `ARTIFACT_S3_CHECKSUM=none`; server-side signature verification still applies.
7. R4: apply 00033 before deploying the matching build. Publishing needs no new configuration; manual
   publications appear as notifications and in Jobs when due.
8. R7: apply 00034. System health shows "no tick recorded" until the first tick after deploy.
9. Keep `PAID_COMPUTE_ALLOWED=false`, `MAX_BACKGROUND_WORKERS=1`, `MAX_BROWSER_CONCURRENCY=1`.
10. R6: apply 00035. Browser executor (Northflank **Job 1**, free Sandbox job, never a service): build
    `workers/browser-executor/Dockerfile` with the repository root as context; set `ZERNFLOW_URL` (https),
    `ZERNFLOW_WORKER_TOKEN` (Jobs → Workers, mode `browser`, concurrency 1), `BROWSER_IDLE_SHUTDOWN=true`,
    `BROWSER_JOB_MAX_MS=600000`; schedule it every 15–60 min (or trigger manually). Checks queue until it runs.
    Optionally set `BROWSER_SESSION_CHECK_HOURS` on Service 1 (default 24, 0 disables scheduled checks).
11. R9: apply 00036. To capture website leads, create a token under Campaigns → Lead intake and call
    `POST /api/intake/v1/leads` from your **server** (never from public page code). Optionally set
    `LEAD_INTAKE_RATE_PER_MINUTE`. Confirm manual publications with the platform post ID to count comments.
12. R8: apply 00037 (no behaviour change: all routes stay `scheduled_jobs`). Then follow
    `docs/architecture/LEGACY_JOBS_MIGRATION.md` §3 to flip one type at a time. Optional Zernio brownout:
    `LEGACY_ZERNIO_WEBHOOK=reject`. Optional `NEXT_PUBLIC_SOURCE_URL` for the landing page source link.
13. R10 + R11: apply 00038 then 00039 before deploying the matching build. 00039 is additive: CHECKs widened,
    two indexes, two nullable columns. Its only tightening is a format CHECK on account refs that start with
    `manual:`, which the Gateway never issues. Pre-check:
    `select count(*) from channels where late_account_id like 'manual:%'` should return 0.
    Add `transit/rewrap/<key>` to the Vault policy. No other new configuration is needed.

## Production certification still required
- R1 behaviour on a real Supabase project (RLS/grants under PostgREST, realtime) and live Gateway webhooks.
- R2: tick cadence and lease recovery on real Postgres under PostgREST; Northflank cron wiring.
- R3: Vault Transit against the real Vault (policy, token renewal, availability). Run one KEK rotation with
  `secrets.rewrap` following `SECRET_STORE_DESIGN.md` §5.1.
- R5: presigned upload/download against the chosen provider (checksum and SSE header support vary by vendor);
  bucket CORS; lifecycle rules.
- R4: apply 00033 on a real project and verify the backfill (`select count(*) from editorial_drafts where
  campaign <> '' and campaign_id is null` = 0); scheduling and reconcile under real PostgREST.
- R9: apply 00036 on a real project. Verify the attribution guard triggers under PostgREST (role
  `authenticated`), `campaign_engagement` performance on real `comment_logs` volumes, and the intake endpoint
  behind the production proxy.
- R6: a live session check per adapter against real accounts (selectors/signals are fixture-tested only, hence
  `experimental`); verify the `mcr.microsoft.com/playwright:v1.63.0-noble` tag exists and matches
  `playwright-core`; Chromium in the Northflank job (memory limit, `/dev/shm`); confirm each platform's terms
  permit this use for the operator's account before enabling the experimental opt-in.
- R8: each flipped legacy type runs on tasks for ≥ 14 days with removal criteria (§4 of
  `LEGACY_JOBS_MIGRATION.md`) met before the legacy drain is removed.
- R10: after the transport exists, run a contract test against the Gateway's fixtures and one live publish to
  a test account per platform before any connected channel is offered API publishing.
- R11: apply 00039 on a real project. Create one manual channel, one repeat schedule (confirm the draft copy and
  the notification), and page through the audit log across a page boundary.
- No part of the program is certified for production yet.

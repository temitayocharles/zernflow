# ZernFlow — Target Architecture

ZernFlow is a self-hosted, persistent **creator/social operations system**: it holds campaigns, content,
automations, conversations and customer context, and keeps executing scheduled work while the operator is
offline — observably, auditably and under the operator's control.

## 1. Hard constraints

1. **$0 infrastructure spend.** Horizontal scaling must never implicitly require a paid plan. Heavy work is
   dispatchable to externally configured workers (self-hosted K3s, free job capacity). Paid services are
   optional adapters, never requirements. Queues wait instead of scaling.
2. **API first.** Execution priority: official API → Gateway/OAuth provider adapter → managed browser.
3. **Agent Social Gateway remains the provider boundary** for OAuth, provider credentials, inbound events,
   messages and outbound provider operations. ZernFlow never stores provider OAuth tokens that the Gateway owns.
4. **Tenant isolation everywhere** (RLS + composite FKs + server-side scoping + per-workspace object prefixes).
5. Forward-only migrations; staged consolidation; no giant rewrite.

## 2. Runtime topology ($0)

```text
NORTHFLANK SANDBOX (compute only)                      EXTERNAL / EXISTING (free or self-hosted)
┌──────────────────────────────────────┐             ┌───────────────────────────────────────────┐
│ Service 1: ZernFlow (Next.js)        │── SQL ─────►│ Supabase Postgres/Auth/Realtime (free)    │
│  UI · API · light worker (/api/cron) │── S3 API ──►│ S3-compatible object storage (free tier / │
│  campaign + scheduling coordinator   │             │   MinIO/Garage on K3s)                    │
│  secret store (envelope encryption)  │── Transit ─►│ Vault (existing) — root KEK, never exported│
├──────────────────────────────────────┤             └───────────────────────────────────────────┘
│ Service 2: Agent Social Gateway      │◄─ REST ─── ZernFlow   ─── signed webhooks ──► ZernFlow
├──────────────────────────────────────┤
│ Free job #1: Browser executor        │── worker API (token, lease) ──► ZernFlow
│  Playwright/Chromium, concurrency 1  │── presigned PUT ──► object storage
├──────────────────────────────────────┤
│ Free job #2: Maintenance tick (cron) │── GET /api/cron/tick (Bearer CRON_SECRET)
└──────────────────────────────────────┘
When free capacity is exhausted: DO NOT UPGRADE → run the same browser-executor image / tick caller on K3s.
```

Key property: **remote workers hold no database or Vault credentials.** They authenticate with a scoped
worker token, lease one task at a time and receive only the material that task needs (see
`EXECUTION_MODEL.md`, `BROWSER_AUTOMATION_DESIGN.md`).

### Zero-cost safeguards (environment, enforced in code — `lib/runtime/budget.ts`)

| Variable | Default | Effect |
| --- | --- | --- |
| `PAID_COMPUTE_ALLOWED` | `false` | Any adapter flagged `paid` refuses to run. |
| `MAX_BACKGROUND_WORKERS` | `1` | Tasks claimed per tick batch are serialized. |
| `MAX_TASKS_PER_TICK` | `10` | Bounded work per cron invocation. |
| `TICK_TIME_BUDGET_MS` | `25000` | The tick stops claiming when the budget is spent. |
| `MAX_BROWSER_CONCURRENCY` | `1` | Browser leases per worker identity / globally. |
| `BROWSER_IDLE_SHUTDOWN` | `true` | Executor exits when no task is available (job semantics). |
| `MAX_UPLOAD_SIZE_BYTES` | `104857600` (100 MiB) | Hard object size limit. |
| `MAX_ARTIFACT_RETENTION_DAYS` | `30` | Execution artifacts (screenshots/traces) expire. |

## 3. Product domains

| Domain | Owns | Primary tables |
| --- | --- | --- |
| Workspaces & team | membership, roles, invites, gateway binding | `workspaces`, `workspace_members`, `workspace_invites`, `gateway_workspace_bindings` |
| Connected accounts | projected Gateway accounts + browser sessions | `channels`, `browser_sessions` |
| Campaign OS | objective, audience, channels, voice, plan, UTMs, status, owner, approvals | `campaigns` |
| Content & publishing | content items, channel variants, publish state, receipts | `editorial_drafts` (content items), `editorial_variants` (channel variants) |
| Automation & engagement | flows, triggers, comment rules, sequences, broadcasts | existing tables |
| Inbox | projected conversations, notes, assignments, takeover | existing tables |
| Customer 360 | contacts, identities, CRM entities, activity | existing tables |
| Execution plane | durable tasks, schedules, execution records, dead letters | `tasks`, `task_events`, `task_schedules`, `execution_records`, `worker_identities` |
| Secrets | envelope-encrypted versions, access audit | `secrets`, `secret_versions`, `secret_access_events` |
| Artifacts | object metadata, retention | `artifacts` |
| Observability & audit | product activity, execution records, notifications | `product_activity`, `execution_records`, `operator_notifications` |

## 4. Boundaries (what may not cross)

* **Gateway owns**: provider OAuth tokens, provider webhook secrets, inbound normalization, authoritative
  messages, durable provider operations. ZernFlow references them by id (`channels.late_account_id`,
  Gateway operation ids in `execution_records.external_ref`).
* **ZernFlow owns**: campaigns, content, schedules, tasks, execution records for actions *ZernFlow initiates*,
  browser sessions (for providers the Gateway cannot serve), ZernFlow-scoped secrets (browser credentials,
  session cookies, outbound webhook signing keys, AI keys), artifacts.
* **Publishing** is dispatched through a capability-resolved executor chain:
  `GatewayPublishingExecutor` (only when the account reports the capability) → `BrowserPublishingExecutor`
  (only when a healthy session + verified adapter capability + workspace opt-in exist) → otherwise the task
  moves to `waiting_for_user` with an explicit reason. No capability is ever assumed.

## 5. Control plane (navigation)

```
Overview:   Dashboard
Plan:       Campaigns · Content · Calendar · Assets
Engage:     Inbox · Automations (Flows, Comment rules, Sequences, Broadcasts)
Customers:  Contacts (+ Companies/Deals/Customer 360) · Work items
Operate:    Jobs · Connected accounts · Browser sessions · Notifications
Insights:   Analytics
Admin:      Secrets · Team · System health · Audit log · Settings
```

Pages that exist only for historical reasons (generic configuration editors, mailbox identities, knowledge)
remain reachable from Settings but are removed from primary navigation.

## 6. Persistent-operator behavior

* All long-running intent is persisted as `tasks` with state machines and idempotency keys; `task_schedules`
  materialize recurring work; every external call writes an `execution_record`.
* The tick is stateless and safe to run concurrently (claims use `FOR UPDATE SKIP LOCKED` + leases).
* The dashboard answers: what succeeded, what failed, what needs approval, what needs re-authentication.

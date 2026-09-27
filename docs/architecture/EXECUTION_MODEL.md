# Execution Model — durable tasks, schedules, workers

## 1. Principles

* Intent is persisted before execution. A task survives app and worker restarts.
* Claims are **leases**: `claim_tasks()` uses `FOR UPDATE SKIP LOCKED`, sets `lease_owner` and
  `lease_expires_at`. Expired leases are recovered by the next tick (state back to `retrying` with attempt
  accounting), so a crashed worker never strands work.
* Every external action carries an **idempotency key** derived from stable identity
  (`zernflow:publish:<variant_id>:<variant_version>`), passed to the Gateway/adapter and stored on the task.
* Queues wait instead of scaling (see budget variables in `TARGET_ARCHITECTURE.md`).

## 2. Task state machine (enforced by `task_transition_guard` trigger)

```
queued ──claim──► running ──ok──► completed
  ▲                 │ ├─needs external progress──► waiting ──due──► queued
  │                 │ ├─needs human / reauth / approval──► waiting_for_user ──resolve──► queued
  │                 │ ├─retryable error & attempts left──► retrying ──due──► running (claim)
  │                 │ └─terminal error / attempts exhausted──► failed (dead_lettered_at set)
  └──retry (operator)── failed / cancelled? (failed only)
any non-terminal ──cancel──► cancelled
```

Terminal states: `completed`, `failed`, `cancelled`. `failed` + `dead_lettered_at` = dead letter; the Jobs page
lists dead letters and allows an operator **retry** (resets attempts, new `next_run_at`) or **cancel**.

Approval gate: a task with `requires_approval=true` is created with `approval_state='pending'` and is not
claimable until an owner approves (`approve_task` RPC). Rejection cancels it.

## 3. Claiming and modes

| Mode | Who executes | How |
| --- | --- | --- |
| `internal` | Light worker in ZernFlow tick | handler registry (`lib/tasks/handlers`) |
| `api` | Light worker | Gateway/provider adapter via capability resolution |
| `browser` | Remote browser executor | `/api/worker/v1/*` lease protocol |
| `human` | Operator | appears in Jobs/Inbox as `waiting_for_user` |

`claim_tasks(p_worker, p_modes, p_limit, p_lease_seconds)` — service-role only.
Remote workers call the worker API; the API calls the RPC with the worker identity's allowed modes and
workspace restriction. Browser leases are capped by `MAX_BROWSER_CONCURRENCY` (count of running browser
tasks per worker identity and globally).

## 4. Retry policy and error taxonomy

`retry_policy = {maxAttempts: 5, baseDelayMs: 30000, maxDelayMs: 3600000}` by default; delay =
`min(base * 2^(attempt-1), max)` with ±20% jitter (`lib/tasks/retry.ts`).

| `error_class` | Retry decision |
| --- | --- |
| `transient` (timeouts, 5xx, network) | retry |
| `rate_limited` | retry after provider hint or backoff |
| `auth_expired` / `reauth_required` | needs_user (session → reauth; task → waiting_for_user) |
| `human_challenge` (MFA/CAPTCHA/checkpoint) | needs_user — never bypassed |
| `unsupported_capability` | needs_user (no executor can perform it) |
| `validation` / `policy_denied` | give_up |
| `unknown_outcome` | needs_user (possible duplicate risk; operator must reconcile) |
| `internal` | retry up to limit, then dead letter |

## 5. Schedules

`task_schedules` rows (interval or 5-field cron subset, timezone) are materialized by the tick:
`materialize_due_schedules()` inserts the next task with idempotency key `schedule:<id>:<run_at>` and advances
`next_run_at` atomically, so concurrent ticks cannot double-create.

## 6. The tick (`GET /api/cron/tick`)

Order, within `TICK_TIME_BUDGET_MS`:
1. recover expired leases; 2. materialize schedules; 3. run up to `MAX_TASKS_PER_TICK` internal/api tasks;
4. existing `scheduled_jobs` batch (flow resumes, broadcasts, gateway events); 5. sequences;
6. maintenance (artifact retention, SLA scan). Each stage reports its own status; a failed stage does not hide
the results of others. `/api/cron/jobs` and `/api/cron/sequences` remain for compatibility.

## 7. Legacy queues (consolidation plan)

`scheduled_jobs` keeps its proven CAS logic for `resume_flow`, `send_broadcast`,
`process_social_gateway_event`. Phase R6 migrates these job types into `tasks` handlers one at a time behind
a feature flag with dual-read, then retires `scheduled_jobs`. Until then the table is service-role only.

## 8. Observability

* `correlation_id` is minted per task and propagated in `x-correlation-id` headers to the Gateway and in
  structured logs (`lib/observability/log.ts`, JSON lines, secret-redacting).
* Metrics seam: `lib/observability/metrics.ts` counters/histograms (in-process; exporter optional, $0).
* Trace seam: `withSpan(name, fn)` wrapper records durations into execution records; OpenTelemetry can be
  attached later without changing call sites.

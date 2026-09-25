# Legacy `scheduled_jobs` → durable `tasks` migration (R8)

Status: **code-complete; cut-over needs live evidence.** Migration `00037_legacy_jobs_to_tasks.sql`
defaults every producer to the legacy queue, so deploying this code changes no runtime behaviour.

## 1. What moved

| Legacy type (`scheduled_jobs.type`) | Producer | Task kind | Idempotency key |
| --- | --- | --- | --- |
| `resume_flow` | flow engine delay node → `schedule_flow_resume` RPC (`lib/jobs/schedule-resume.ts`) | `flow.resume` | `flow-resume:<session>:<node>:<runAt>` |
| `send_broadcast` | `schedule_broadcast_delivery` RPC (same signature as 00030) | `broadcast.deliver` | `broadcast:<recipientId>` |
| `process_social_gateway_event` | `claim_social_gateway_webhook` RPC (same signature as 00019) | `gateway.event` | `gateway-event:<eventId>` |

- Unit-of-work code lives in one place, `lib/jobs/legacy-work.ts`, and is called by both the legacy drain
  (`app/api/cron/jobs/route.ts`) and the task handlers (`lib/jobs/legacy-task-handlers.ts`).
- Broadcast Gateway sends keep the idempotency key `zernflow:broadcast:<recipientId>` in both queues.
  A recipient that moves between queues cannot be sent twice.

## 2. Parity rules (tested in `lib/jobs/legacy-task-handlers.test.ts`)

| Legacy drain behaviour | Task behaviour |
| --- | --- |
| 3 attempts, backoff 2^(n+1)·5 s | `retry_policy {maxAttempts:3, baseDelayMs:10000}`: every ordinary error is retried (class `internal`), whatever the error class |
| Gateway operation pending: requeue at 5 s·2^n (max 5 min), attempts not consumed, `operationId` kept in the payload | `deferred` (`defer_task` gives the attempt back); `operationId` and the check count are kept in `tasks.current_step` as `gateway-op:<n>:<id>` |
| `SessionRecheckError`: requeue after 5 min, attempts not consumed | `deferred` for 5 min |
| `SessionCancelError` or last attempt: fail and settle (cancel the session, fail the recipient and settle the broadcast, or fail the webhook ledger row) | Settle first, then mark `current_step='settled'`, then a terminal `TaskError` (dead-letter, `give_up`) |
| Stale claim with attempts exhausted: settle gated on the session not being parked | Sweep `legacyTaskSettle` settles failed legacy-kind tasks that skipped the handler (e.g. an expired lease), using the same gate |
| "Session parked by another resume" checks `scheduled_jobs` | Checks **both** `scheduled_jobs` and `tasks` (`flow.resume`, subject = session) |

Guards in SQL (tested in `supabase/tests/legacy-jobs-routing.db.test.ts`):
- A broadcast recipient is enqueued at most once across both queues.
- A Gateway event is re-queued (`failed`/`waiting_for_user` → `queued`) only through the same ledger rules as before.
- A Gateway event whose channel has no workspace, or whose envelope is over 60 kB, falls back to the legacy queue.
- `schedule_flow_resume` refuses a session from another workspace.
- `legacy_queue_routes` and all the new RPCs are service-role only.

## 3. Cut-over (operator, per type, reversible)

Preconditions (LIVE_RUNTIME): migration 00037 applied, and the cron tick healthy (System health → Scheduler tick is ok).

1. Baseline: run `select * from legacy_queue_status();`.
2. Flip one type, starting with the lowest-risk one (`send_broadcast`, then `process_social_gateway_event`, then `resume_flow`):
   ```sql
   update legacy_queue_routes set target = 'tasks', note = 'R8 cut-over <date> <operator>', updated_at = now()
    where job_type = 'send_broadcast';
   ```
3. Verify with a real unit of work, e.g. send a one-recipient broadcast:
   - Jobs shows a `broadcast.deliver` task that reaches `completed`;
   - the recipient is `sent`;
   - no new `scheduled_jobs` row exists for that recipient;
   - System health → Legacy job queue shows `send_broadcast→tasks`.
4. Leave it for at least 24 h. Check Jobs for `failed` tasks of the flipped kind, and the logs for `task.failed`.

**Rollback:** run the same `update` with `target = 'scheduled_jobs'`. Tasks that were already enqueued still run, because the handlers stay registered. Legacy rows keep draining either way.

## 4. Final removal (PRODUCTION_CERTIFICATION: do not remove before every check passes)

Remove the legacy drain (tick stage `legacyJobs`, `app/api/cron/jobs`) and later drop `scheduled_jobs` only when **all** of these hold:

1. `select job_type, target from legacy_queue_routes` returns `tasks` for all three types, and has done for at least 14 days.
2. `select * from legacy_queue_status()` returns `pending = 0` and `processing = 0` for every type.
3. `select count(*) from scheduled_jobs where created_at > now() - interval '14 days'` returns 0. This proves that nothing, including the `schedule_flow_resume` fallback insert, still writes there.
4. No `schedule_flow_resume unavailable` warnings in the web service logs for 14 days.
5. The flipped task kinds show no dead-letter spike compared with the legacy failure rate. Compare `failed_7d` from `legacy_queue_status()` before the flip with failed tasks of those kinds afterwards.

Then, in order:
- Remove the legacy drain code.
- Remove the fallback insert in `lib/jobs/schedule-resume.ts`.
- Remove the `legacy_queue_routes` branches (a forward migration makes the RPCs task-only).
- Much later, in a separate forward migration, archive and drop `scheduled_jobs`. Never edit 00001–00037.

## 5. Not changed by R8

- The Zernio `webhook_events` prune and the SLA refresh still run in the legacy drain route. They move to maintenance sweeps together with the drain removal (step 4), so the removal PR must carry them over.
- Sequence polling (`/api/cron/sequences`) is a separate legacy queue. It is not part of R8 and stays as it is.

# Migration Plan

All changes are forward migrations appended after `00029`. Historical files are untouched. Every migration is
executed in the PGlite test harness together with the complete history (`lib/test/pg-harness.ts`), including
Supabase-style default grants to `anon`/`authenticated`.

| # | File | Contents | Rollback posture |
| --- | --- | --- | --- |
| 00030 | `tenant_security_hardening.sql` | `scheduled_jobs.workspace_id` + backfill; drop permissive job policies; revoke client grants; `schedule_broadcast_delivery` RPC (honors `scheduled_for`, dedupe keys); workspace-consistency triggers on legacy tables; client column grants excluding secret columns on `workspaces`/`channels` (no client INSERT on `channels`: projections are written server-side after the binding check); `gateway_workspace_bindings`; conditional unique index on projected gateway account ids | Never restore broad grants as rollback. App rollback is safe: old code path for broadcast scheduling would fail closed (permission denied) rather than leak. |
| 00031 | `durable_tasks_execution.sql` | `tasks`, `task_events`, `task_schedules`, `execution_records`, `worker_identities`; transition guard; claim/lease/recover/materialize/complete/fail RPCs (service-role only); `approve_task`, `cancel_task`, `retry_task` RPCs (member/owner checked) | Additive. |
| 00032 | `secrets_artifacts_browser_sessions.sql` | `secrets`, `secret_versions` (no client grants), `secret_access_events`, `artifacts`, `browser_sessions`; widens `operator_notifications.entity_type` to platform entities | Additive. Renumbered ahead of campaigns because R3 shipped before R4. |
| 00033 | `campaigns_publishing.sql` | `campaigns`; content item/variant publish columns; backfill campaigns from `editorial_drafts.campaign`; publish transition guard; `content_publish_summary()`; `schedule_content_item()` RPC creating idempotent publish tasks | Additive; legacy `campaign` column retained. |

## Deployment procedure

1. Apply 00030–00033 in order (Supabase CLI `db push` or ordered manual execution). Record SHA and time.
2. Deploy the application build from the same commit.
3. Set `SOCIAL_GATEWAY_BOUND_WORKSPACE_ID` to the production workspace UUID (or let the migration backfill
   the binding when exactly one workspace already projects Gateway channels — see 00030 notes).
4. Configure `SECRET_STORE_KEK_PROVIDER=vault-transit` with `VAULT_ADDR`, `VAULT_TOKEN` (policy limited to
   transit encrypt/decrypt), `VAULT_TRANSIT_KEY`.
5. Configure object storage variables; run `GET /api/v1/system/health` as an owner to confirm.
6. Point the Northflank maintenance cron job at `GET /api/cron/tick` with `Authorization: Bearer $CRON_SECRET`
   (replaces separate jobs/sequences cron entries; they remain callable).
7. Issue a worker token (Settings → System health → Workers) for the browser executor job.

## Verification queries

```sql
select count(*) from pg_policies where tablename='scheduled_jobs';                      -- expect 0
select has_table_privilege('authenticated','public.scheduled_jobs','select');         -- expect false
select has_column_privilege('authenticated','public.workspaces','ai_api_key','select'); -- expect false
select has_table_privilege('authenticated','public.secret_versions','select');         -- expect false
select to_regprocedure('public.claim_tasks(text,text[],integer,integer,uuid)');         -- not null
```

## Data migrations requiring the application (not SQL)

* Legacy plaintext secrets → secret store: owner action `Import legacy secrets` (encryption requires the
  KEK, which is intentionally unavailable to SQL).
* Later forward migration (after Zernio stage 2) drops legacy secret columns.

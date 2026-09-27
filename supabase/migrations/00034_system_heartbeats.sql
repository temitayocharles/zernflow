-- R7: deployment heartbeats for System health.
-- One row per component (scheduler tick, workers report through worker_identities).
-- Contains only non-sensitive status: timestamps, a status word, and stage names.
-- Readable by any signed-in user (it describes the shared deployment, not a workspace);
-- written only by the service role.

create table system_heartbeats (
  component text primary key check (component ~ '^[a-z][a-z0-9_.-]{1,62}$'),
  last_run_at timestamptz not null,
  last_ok_at timestamptz,
  status text not null check (status in ('ok', 'degraded', 'failed')),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048)
);

alter table system_heartbeats enable row level security;
revoke all on system_heartbeats from anon, authenticated;
grant select on system_heartbeats to authenticated;
grant select, insert, update, delete on system_heartbeats to service_role;
create policy signed_in_read on system_heartbeats for select to authenticated using (true);

-- Atomic upsert that keeps last_ok_at when the current run is not ok.
create function record_heartbeat(p_component text, p_status text, p_duration_ms integer, p_detail jsonb)
returns void language sql security definer set search_path = public as $$
  insert into system_heartbeats(component, last_run_at, last_ok_at, status, duration_ms, detail)
  values (p_component, now(), case when p_status = 'ok' then now() end, p_status, p_duration_ms, coalesce(p_detail, '{}'::jsonb))
  on conflict (component) do update set
    last_run_at = excluded.last_run_at,
    last_ok_at = coalesce(excluded.last_ok_at, system_heartbeats.last_ok_at),
    status = excluded.status,
    duration_ms = excluded.duration_ms,
    detail = excluded.detail;
$$;
revoke all on function record_heartbeat(text, text, integer, jsonb) from public, anon, authenticated;
grant execute on function record_heartbeat(text, text, integer, jsonb) to service_role;

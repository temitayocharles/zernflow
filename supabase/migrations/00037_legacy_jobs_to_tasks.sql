-- R8: route the three legacy scheduled_jobs producers into the durable task
-- plane behind a deployment-level switch.
--
-- Compatibility contract
--   * Default target for every legacy type is 'scheduled_jobs': applying this
--     migration changes no runtime behaviour until an operator flips a route.
--   * The legacy /api/cron/jobs drain keeps running (cron tick stage
--     legacyJobs), so rows queued before or after a flip always drain.
--   * The task handlers (flow.resume, broadcast.deliver, gateway.event) stay
--     registered regardless of the switch, so flipping back never strands
--     tasks that were already enqueued.
--   * A logical unit of work is enqueued at most once across BOTH queues
--     (broadcast recipient, Gateway event); resume jobs are unique per
--     (session, node, run time).
--
-- Flip (operator, per type, reversible):
--   update legacy_queue_routes set target = 'tasks', updated_at = now()
--    where job_type = 'send_broadcast';
-- Rollback: set target back to 'scheduled_jobs'. See docs/architecture/LEGACY_JOBS_MIGRATION.md.

create table if not exists legacy_queue_routes (
  job_type text primary key
    check (job_type in ('resume_flow', 'send_broadcast', 'process_social_gateway_event')),
  target text not null default 'scheduled_jobs' check (target in ('scheduled_jobs', 'tasks')),
  note text check (note is null or length(note) <= 500),
  updated_at timestamptz not null default now()
);
insert into legacy_queue_routes(job_type) values
  ('resume_flow'), ('send_broadcast'), ('process_social_gateway_event')
on conflict (job_type) do nothing;

-- Deployment-wide operator switch: never readable or writable by tenants.
alter table legacy_queue_routes enable row level security;
revoke all on legacy_queue_routes from public, anon, authenticated;
grant select, update on legacy_queue_routes to service_role;

comment on table legacy_queue_routes is
  'R8 compatibility seam: which queue each legacy producer writes to. Default scheduled_jobs (pre-R8 behaviour).';

create or replace function legacy_queue_target(p_job_type text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select target from legacy_queue_routes where job_type = p_job_type), 'scheduled_jobs');
$$;
revoke all on function legacy_queue_target(text) from public, anon, authenticated;
grant execute on function legacy_queue_target(text) to service_role;

-- Task kinds produced here, with the legacy retry budget (3 attempts,
-- ~10 s then ~20 s backoff) so behaviour matches the scheduled_jobs drain.
create or replace function legacy_task_retry_policy() returns jsonb
language sql immutable set search_path = public as $$
  select '{"maxAttempts":3,"baseDelayMs":10000,"maxDelayMs":300000}'::jsonb;
$$;
revoke all on function legacy_task_retry_policy() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Producer 1: flow delay resume (was a direct insert in executeDelay).
-- ---------------------------------------------------------------------------
create or replace function schedule_flow_resume(p_payload jsonb, p_run_at timestamptz)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_ws uuid;
  v_session uuid;
  v_key text;
begin
  if jsonb_typeof(p_payload) <> 'object'
     or coalesce(p_payload->>'workspaceId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(p_payload->>'sessionId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(p_payload->>'nodeId', '') = '' then
    raise exception 'resume payload requires workspaceId, sessionId and nodeId' using errcode = '22023';
  end if;
  v_ws := (p_payload->>'workspaceId')::uuid;
  v_session := (p_payload->>'sessionId')::uuid;
  if not exists (select 1 from flow_sessions s join flows f on f.id = s.flow_id
                 where s.id = v_session and f.workspace_id = v_ws) then
    raise exception 'flow session does not belong to workspace' using errcode = '23514';
  end if;

  if legacy_queue_target('resume_flow') = 'tasks' and pg_column_size(p_payload) <= 60000 then
    v_key := left('flow-resume:' || v_session || ':' || (p_payload->>'nodeId') || ':'
      || to_char(p_run_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISS.MS'), 300);
    insert into tasks(workspace_id, kind, objective, idempotency_key, input, execution_mode,
                      next_run_at, retry_policy, subject_type, subject_id)
    values (v_ws, 'flow.resume', 'Resume flow after delay', v_key, p_payload, 'internal',
            coalesce(p_run_at, now()), legacy_task_retry_policy(), 'flow_sessions', v_session)
    on conflict (workspace_id, idempotency_key) do nothing;
    return 'tasks';
  end if;

  insert into scheduled_jobs(workspace_id, type, payload, run_at)
  values (v_ws, 'resume_flow', p_payload, coalesce(p_run_at, now()));
  return 'scheduled_jobs';
end $$;
revoke all on function schedule_flow_resume(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function schedule_flow_resume(jsonb, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Producer 2: broadcast delivery (same signature/contract as 00030).
-- ---------------------------------------------------------------------------
create or replace function schedule_broadcast_delivery(p_broadcast_id uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  b record;
  first_run timestamptz;
  scheduled integer;
  total integer;
begin
  select id, workspace_id, status, scheduled_for into b from broadcasts where id = p_broadcast_id for update;
  if not found or not is_workspace_member(b.workspace_id) then
    raise exception 'broadcast unavailable' using errcode = '42501';
  end if;
  if b.status not in ('draft', 'scheduled') then
    raise exception 'broadcast already dispatched' using errcode = '23514';
  end if;
  first_run := greatest(now(), coalesce(b.scheduled_for, now()));

  if legacy_queue_target('send_broadcast') = 'tasks' then
    insert into tasks(workspace_id, kind, objective, idempotency_key, input, execution_mode,
                      next_run_at, retry_policy, subject_type, subject_id)
    select b.workspace_id, 'broadcast.deliver', 'Deliver broadcast message', 'broadcast:' || r.id,
           jsonb_build_object('broadcastId', b.id, 'recipientId', r.id), 'internal',
           first_run + ((row_number() over (order by r.id)) - 1) * interval '100 milliseconds',
           legacy_task_retry_policy(), 'broadcast_recipients', r.id
    from broadcast_recipients r
    where r.broadcast_id = b.id and r.status = 'pending'
      and not exists (select 1 from scheduled_jobs j
                      where j.type = 'send_broadcast' and j.dedupe_key = 'broadcast:' || r.id)
    on conflict (workspace_id, idempotency_key) do nothing;
  else
    insert into scheduled_jobs(type, payload, run_at, status, attempts, dedupe_key, workspace_id)
    select 'send_broadcast',
           jsonb_build_object('broadcastId', b.id, 'recipientId', r.id),
           first_run + ((row_number() over (order by r.id)) - 1) * interval '100 milliseconds',
           'pending', 0, 'broadcast:' || r.id, b.workspace_id
    from broadcast_recipients r
    where r.broadcast_id = b.id and r.status = 'pending'
      and not exists (select 1 from tasks t
                      where t.workspace_id = b.workspace_id and t.idempotency_key = 'broadcast:' || r.id)
    on conflict (type, dedupe_key) do nothing;
  end if;
  get diagnostics scheduled = row_count;

  select count(*) into total from broadcast_recipients where broadcast_id = b.id;
  if total = 0 then
    raise exception 'broadcast has no recipients' using errcode = '23514';
  end if;
  update broadcasts
     set status = case when first_run > now() + interval '5 seconds' then 'scheduled' else 'sending' end,
         total_recipients = total
   where id = b.id;
  return scheduled;
end $$;
revoke all on function schedule_broadcast_delivery(uuid) from public, anon;
grant execute on function schedule_broadcast_delivery(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Producer 3: signed Gateway webhook claim (same signature/contract as 00019).
-- ---------------------------------------------------------------------------
create or replace function claim_social_gateway_webhook(
  p_event_id text,
  p_delivery_id text,
  p_event_type text,
  p_channel_id uuid,
  p_envelope jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare
  inserted_event_id text;
  existing_status text;
  conflicting_event_id text;
  v_ws uuid;
  v_input jsonb;
begin
  insert into webhook_events (event_id, source, delivery_id, event_type, status, attempt_count,
                              claimed_at, completed_at, last_error)
  values (p_event_id, 'social_gateway', p_delivery_id, p_event_type, 'processing', 1, now(), null, null)
  on conflict do nothing
  returning event_id into inserted_event_id;

  if inserted_event_id is null then
    select event_id into conflicting_event_id from webhook_events where delivery_id = p_delivery_id;
    if conflicting_event_id is not null and conflicting_event_id <> p_event_id then
      raise exception 'delivery id is already assigned to a different event';
    end if;

    select status into existing_status from webhook_events where event_id = p_event_id for update;
    if existing_status is null then
      raise exception 'event claim conflict could not be resolved';
    end if;
    if existing_status = 'completed' then
      return 'completed';
    end if;
    if existing_status = 'processing' then
      return 'already_queued';
    end if;

    update webhook_events
       set source = 'social_gateway', delivery_id = p_delivery_id, event_type = p_event_type,
           status = 'processing', attempt_count = attempt_count + 1, claimed_at = now(),
           completed_at = null, last_error = null
     where event_id = p_event_id;
  end if;

  v_input := jsonb_build_object('eventId', p_event_id, 'channelId', p_channel_id, 'envelope', p_envelope);
  select workspace_id into v_ws from channels where id = p_channel_id;

  -- Tasks need a tenant; oversized envelopes exceed the task input bound.
  -- Both fall back to the legacy queue, which has neither constraint.
  if legacy_queue_target('process_social_gateway_event') = 'tasks'
     and v_ws is not null and pg_column_size(v_input) <= 60000 then
    insert into tasks(workspace_id, kind, objective, idempotency_key, input, execution_mode,
                      next_run_at, retry_policy, subject_type)
    values (v_ws, 'gateway.event', 'Process Agent Social Gateway event',
            left('gateway-event:' || p_event_id, 300), v_input, 'internal', now(),
            legacy_task_retry_policy(), 'webhook_events')
    on conflict (workspace_id, idempotency_key) do update
      set state = 'queued', attempts = 0, next_run_at = now(), error = null,
          dead_lettered_at = null, finished_at = null, current_step = null,
          human_intervention = case when tasks.state = 'waiting_for_user' then 'resolved'
                                    else tasks.human_intervention end
      where tasks.state in ('failed', 'waiting_for_user');
  else
    insert into scheduled_jobs (type, payload, run_at, status, attempts, last_error, claimed_at, dedupe_key)
    values ('process_social_gateway_event', v_input, now(), 'pending', 0, null, null, p_event_id)
    on conflict (type, dedupe_key) do update
      set payload = excluded.payload, run_at = now(), status = 'pending', attempts = 0,
          last_error = null, claimed_at = null;
  end if;

  return case when inserted_event_id is null then 'requeued' else 'queued' end;
end $$;
revoke all on function claim_social_gateway_webhook(text, text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function claim_social_gateway_webhook(text, text, text, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Migration evidence for operators (service-only): what is still pending in
-- the legacy queue, per type. Final removal of scheduled_jobs requires this
-- to report zero pending/processing rows for every type (see docs).
-- ---------------------------------------------------------------------------
create or replace function legacy_queue_status()
returns table(job_type text, target text, pending bigint, processing bigint, failed_7d bigint, oldest_pending timestamptz)
language sql stable security definer set search_path = public as $$
  select r.job_type, r.target,
         count(j.id) filter (where j.status = 'pending'),
         count(j.id) filter (where j.status = 'processing'),
         count(j.id) filter (where j.status = 'failed' and j.created_at > now() - interval '7 days'),
         min(j.run_at) filter (where j.status = 'pending')
  from legacy_queue_routes r
  left join scheduled_jobs j on j.type = r.job_type
  group by r.job_type, r.target
  order by r.job_type;
$$;
revoke all on function legacy_queue_status() from public, anon, authenticated;
grant execute on function legacy_queue_status() to service_role;

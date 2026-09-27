-- 00031: Durable execution plane — tasks, events, schedules, execution records,
-- worker identities. See docs/architecture/EXECUTION_MODEL.md.
--
-- Browser roles may READ their workspace's rows. They never write these tables
-- directly: operator actions go through membership-checked SECURITY DEFINER
-- RPCs (approve/cancel/retry/resume), and execution goes through service-role
-- RPCs (claim/heartbeat/complete/fail/defer/recover/materialize).

-- ---------------------------------------------------------------------------
-- Worker identities (remote executors; token stored as SHA-256 only)
-- ---------------------------------------------------------------------------
create table worker_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null check (length(token_prefix) between 4 and 16),
  modes text[] not null default array['browser']::text[]
    check (cardinality(modes) between 1 and 3 and modes <@ array['internal','api','browser']::text[]),
  max_concurrency integer not null default 1 check (max_concurrency between 1 and 4),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  unique (workspace_id, id)
);

-- ---------------------------------------------------------------------------
-- Recurring schedules (product-managed; materialized by the tick)
-- ---------------------------------------------------------------------------
create table task_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and length(kind) <= 100),
  input jsonb not null default '{}'::jsonb
    check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 16384),
  execution_mode text not null default 'internal' check (execution_mode in ('internal','api','browser','human')),
  cron text check (cron is null or (length(cron) <= 120 and cron ~ '^[0-9*/,\- ]+$')),
  interval_seconds integer check (interval_seconds is null or interval_seconds between 60 and 31536000),
  timezone text not null default 'UTC' check (length(timezone) between 1 and 64),
  campaign_id uuid,
  enabled boolean not null default true,
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((cron is null) <> (interval_seconds is null)),
  unique (workspace_id, id)
);
create index task_schedules_due_idx on task_schedules(next_run_at) where enabled;

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
create table tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  campaign_id uuid,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and length(kind) <= 100),
  objective text not null check (length(trim(objective)) between 1 and 500),
  state text not null default 'queued'
    check (state in ('queued','running','waiting','waiting_for_user','retrying','completed','failed','cancelled')),
  current_step text check (current_step is null or length(current_step) <= 200),
  depends_on uuid[] not null default '{}'::uuid[] check (cardinality(depends_on) <= 20),
  execution_mode text not null default 'internal' check (execution_mode in ('internal','api','browser','human')),
  retry_policy jsonb not null default '{"maxAttempts":5,"baseDelayMs":30000,"maxDelayMs":3600000}'::jsonb
    check (jsonb_typeof(retry_policy) = 'object'
      and coalesce((retry_policy->>'maxAttempts')::int, 0) between 1 and 20),
  attempts integer not null default 0 check (attempts >= 0),
  next_run_at timestamptz not null default now(),
  lease_owner text check (lease_owner is null or length(lease_owner) <= 200),
  lease_expires_at timestamptz,
  idempotency_key text not null check (length(idempotency_key) between 1 and 300),
  input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 65536),
  result jsonb check (result is null or pg_column_size(result) <= 65536),
  error jsonb check (error is null or (jsonb_typeof(error) = 'object' and pg_column_size(error) <= 8192)),
  requires_approval boolean not null default false,
  approval_state text not null default 'not_required'
    check (approval_state in ('not_required','pending','approved','rejected')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  human_intervention text not null default 'none'
    check (human_intervention in ('none','requested','in_progress','resolved')),
  intervention_reason text check (intervention_reason is null or length(intervention_reason) <= 1000),
  schedule_id uuid,
  correlation_id uuid not null default gen_random_uuid(),
  subject_type text check (subject_type is null or subject_type ~ '^[a-z_]{1,64}$'),
  subject_id uuid,
  priority smallint not null default 0 check (priority between -10 and 10),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  dead_lettered_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, schedule_id) references task_schedules(workspace_id, id) on delete set null (schedule_id),
  check ((approval_state = 'not_required') = (not requires_approval)),
  check ((state = 'running') = (lease_owner is not null and lease_expires_at is not null))
);
create index tasks_claimable_idx on tasks(next_run_at, priority desc)
  where state in ('queued','retrying','waiting');
create index tasks_workspace_state_idx on tasks(workspace_id, state, created_at desc);
create index tasks_running_lease_idx on tasks(lease_expires_at) where state = 'running';
create index tasks_subject_idx on tasks(workspace_id, subject_type, subject_id);
create index tasks_campaign_idx on tasks(workspace_id, campaign_id) where campaign_id is not null;

create table task_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  level text not null default 'info' check (level in ('debug','info','warn','error')),
  message text not null check (length(message) between 1 and 1000),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 8192),
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, task_id) references tasks(workspace_id, id) on delete cascade
);
create index task_events_task_idx on task_events(task_id, created_at);

create table execution_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  task_id uuid,
  correlation_id uuid not null,
  provider text not null check (length(provider) between 1 and 64),
  account_ref text check (account_ref is null or length(account_ref) <= 200),
  operation text not null check (length(operation) between 1 and 100),
  mode text not null check (mode in ('internal','api','browser')),
  attempt integer not null default 1 check (attempt >= 1),
  status text not null default 'started' check (status in ('started','succeeded','failed','unknown')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  result_meta jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result_meta) = 'object' and pg_column_size(result_meta) <= 16384),
  error_class text check (error_class is null or error_class in (
    'transient','rate_limited','auth_expired','reauth_required','human_challenge','unsupported_capability',
    'validation','policy_denied','unknown_outcome','internal')),
  error_message text check (error_message is null or length(error_message) <= 1000),
  retry_decision text not null default 'none' check (retry_decision in ('retry','give_up','needs_user','none')),
  artifact_ids uuid[] not null default '{}'::uuid[] check (cardinality(artifact_ids) <= 50),
  external_ref text check (external_ref is null or length(external_ref) <= 300),
  unique (workspace_id, id),
  foreign key (workspace_id, task_id) references tasks(workspace_id, id) on delete set null (task_id)
);
create index execution_records_task_idx on execution_records(task_id, started_at desc);
create index execution_records_workspace_idx on execution_records(workspace_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Integrity: immutable identity, legal transitions, same-workspace references
-- ---------------------------------------------------------------------------
create or replace function task_transition_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  allowed boolean;
begin
  if TG_OP = 'INSERT' then
    if new.state <> 'queued' or new.attempts <> 0 or new.lease_owner is not null
       or new.result is not null or new.dead_lettered_at is not null then
      raise exception 'tasks must be created queued with no attempts' using errcode = '23514';
    end if;
    if new.requires_approval and new.approval_state <> 'pending' then
      raise exception 'approval-gated tasks must start pending' using errcode = '23514';
    end if;
    if cardinality(new.depends_on) > 0 and exists (
      select 1 from unnest(new.depends_on) d(id)
      where not exists (select 1 from tasks t where t.id = d.id and t.workspace_id = new.workspace_id)
    ) then
      raise exception 'task dependencies must belong to the same workspace' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.workspace_id <> old.workspace_id or new.kind <> old.kind
     or new.idempotency_key <> old.idempotency_key or new.created_at <> old.created_at
     or new.correlation_id <> old.correlation_id or new.depends_on <> old.depends_on
     or new.input <> old.input then
    raise exception 'task identity and input are immutable' using errcode = '23514';
  end if;

  if new.state <> old.state then
    allowed := case old.state
      when 'queued' then new.state in ('running','cancelled')
      when 'retrying' then new.state in ('running','cancelled','failed')
      when 'waiting' then new.state in ('running','queued','cancelled')
      when 'running' then new.state in ('completed','waiting','waiting_for_user','retrying','failed','cancelled')
      when 'waiting_for_user' then new.state in ('queued','cancelled')
      when 'failed' then new.state = 'queued'
      else false
    end;
    if not allowed then
      raise exception 'illegal task transition % -> %', old.state, new.state using errcode = '23514';
    end if;
    if new.state in ('completed','failed','cancelled') then
      new.finished_at := coalesce(new.finished_at, now());
    end if;
  end if;
  if new.state <> 'running' then
    new.lease_owner := null;
    new.lease_expires_at := null;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger task_transition_guard before insert or update on tasks
  for each row execute function task_transition_guard();

create or replace function task_schedule_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.id <> old.id or new.workspace_id <> old.workspace_id or new.created_at <> old.created_at then
    raise exception 'schedule identity is immutable' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger task_schedule_touch before update on task_schedules
  for each row execute function task_schedule_touch();

-- ---------------------------------------------------------------------------
-- Access: members read their workspace; no direct client writes
-- ---------------------------------------------------------------------------
alter table tasks enable row level security;
alter table task_events enable row level security;
alter table task_schedules enable row level security;
alter table execution_records enable row level security;
alter table worker_identities enable row level security;

revoke all on tasks, task_events, task_schedules, execution_records, worker_identities from anon, authenticated;
grant select on tasks, task_events, task_schedules, execution_records to authenticated;
grant select (id, workspace_id, name, token_prefix, modes, max_concurrency, created_by, created_at, last_seen_at, revoked_at)
  on worker_identities to authenticated;

create policy member_read on tasks for select to authenticated using (is_workspace_member(workspace_id));
create policy member_read on task_events for select to authenticated using (is_workspace_member(workspace_id));
create policy member_read on task_schedules for select to authenticated using (is_workspace_member(workspace_id));
create policy member_read on execution_records for select to authenticated using (is_workspace_member(workspace_id));
create policy owner_read on worker_identities for select to authenticated using (is_workspace_owner(workspace_id));

-- ---------------------------------------------------------------------------
-- Internal helper
-- ---------------------------------------------------------------------------
create or replace function task_log(p_workspace uuid, p_task uuid, p_level text, p_message text, p_data jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into task_events(workspace_id, task_id, level, message, data, actor_id)
  values (p_workspace, p_task, p_level, left(p_message, 1000), coalesce(p_data, '{}'::jsonb), auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Service-role execution RPCs
-- ---------------------------------------------------------------------------
create or replace function claim_tasks(
  p_worker text,
  p_modes text[],
  p_limit integer,
  p_lease_seconds integer,
  p_workspace_id uuid default null,
  p_max_running integer default null
) returns setof tasks
language plpgsql security definer set search_path = public as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1), 0), 50);
  v_running integer;
begin
  if p_worker is null or length(p_worker) not between 1 and 200 then
    raise exception 'worker identity required' using errcode = '22023';
  end if;
  if p_max_running is not null then
    select count(*) into v_running from tasks where state = 'running' and lease_owner = p_worker;
    v_limit := least(v_limit, greatest(p_max_running - v_running, 0));
  end if;
  if v_limit = 0 then
    return;
  end if;
  return query
  with candidates as (
    select t.id from tasks t
    where t.state in ('queued','retrying','waiting')
      and t.next_run_at <= now()
      and t.execution_mode = any(p_modes)
      and t.approval_state in ('not_required','approved')
      and (p_workspace_id is null or t.workspace_id = p_workspace_id)
      and not exists (
        select 1 from tasks d
        where d.workspace_id = t.workspace_id and d.id = any(t.depends_on) and d.state <> 'completed'
      )
    order by t.priority desc, t.next_run_at, t.id
    limit v_limit
    for update of t skip locked
  )
  update tasks t
     set state = 'running',
         attempts = t.attempts + 1,
         lease_owner = p_worker,
         lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 3600)),
         started_at = coalesce(t.started_at, now())
    from candidates c
   where t.id = c.id
  returning t.*;
end $$;

create or replace function heartbeat_task(p_task uuid, p_worker text, p_lease_seconds integer)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update tasks
     set lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 3600))
   where id = p_task and state = 'running' and lease_owner = p_worker;
  return found;
end $$;

create or replace function complete_task(p_task uuid, p_worker text, p_result jsonb default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare t tasks;
begin
  update tasks
     set state = 'completed', result = p_result, error = null, human_intervention =
       case when human_intervention in ('requested','in_progress') then 'resolved' else human_intervention end
   where id = p_task and state = 'running' and lease_owner = p_worker
  returning * into t;
  if not found then return false; end if;
  perform task_log(t.workspace_id, t.id, 'info', 'Task completed', jsonb_build_object('attempt', t.attempts));
  return true;
end $$;

-- p_decision: retry | give_up | needs_user. Returns the resulting state, or null if the lease was lost.
create or replace function fail_task(
  p_task uuid, p_worker text, p_error jsonb, p_decision text, p_next_run_at timestamptz default null
) returns text language plpgsql security definer set search_path = public as $$
declare
  t tasks;
  v_max integer;
  v_state text;
begin
  select * into t from tasks where id = p_task and state = 'running' and lease_owner = p_worker for update;
  if not found then return null; end if;
  v_max := coalesce((t.retry_policy->>'maxAttempts')::int, 5);
  if p_decision = 'needs_user' then
    v_state := 'waiting_for_user';
  elsif p_decision = 'retry' and t.attempts < v_max then
    v_state := 'retrying';
  else
    v_state := 'failed';
  end if;
  update tasks
     set state = v_state,
         error = p_error,
         next_run_at = case when v_state = 'retrying' then coalesce(p_next_run_at, now() + interval '30 seconds') else next_run_at end,
         dead_lettered_at = case when v_state = 'failed' then now() else null end,
         human_intervention = case when v_state = 'waiting_for_user' then 'requested' else human_intervention end,
         intervention_reason = case when v_state = 'waiting_for_user' then left(p_error->>'message', 1000) else intervention_reason end
   where id = t.id;
  perform task_log(t.workspace_id, t.id, case when v_state = 'failed' then 'error' else 'warn' end,
    'Attempt ' || t.attempts || ' ' || case v_state
      when 'retrying' then 'failed; retry scheduled'
      when 'waiting_for_user' then 'needs operator action'
      else 'failed; moved to dead letters' end,
    jsonb_build_object('errorClass', p_error->>'class', 'decision', p_decision, 'state', v_state));
  return v_state;
end $$;

-- External progress pending (e.g. provider operation accepted): park without consuming an attempt.
create or replace function defer_task(p_task uuid, p_worker text, p_next_run_at timestamptz, p_step text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare t tasks;
begin
  update tasks
     set state = 'waiting', attempts = greatest(attempts - 1, 0),
         next_run_at = greatest(coalesce(p_next_run_at, now() + interval '1 minute'), now()),
         current_step = coalesce(left(p_step, 200), current_step)
   where id = p_task and state = 'running' and lease_owner = p_worker
  returning * into t;
  if not found then return false; end if;
  perform task_log(t.workspace_id, t.id, 'info', 'Waiting for external progress',
    jsonb_build_object('step', t.current_step, 'nextRunAt', t.next_run_at));
  return true;
end $$;

create or replace function recover_expired_leases() returns integer
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n integer := 0;
  v_state text;
begin
  for r in
    select * from tasks where state = 'running' and lease_expires_at < now()
    order by lease_expires_at limit 200 for update skip locked
  loop
    v_state := case when r.attempts >= coalesce((r.retry_policy->>'maxAttempts')::int, 5) then 'failed' else 'retrying' end;
    update tasks
       set state = v_state,
           error = jsonb_build_object('class', 'internal', 'message', 'Worker lease expired before the task finished', 'retryable', v_state = 'retrying'),
           next_run_at = now(),
           dead_lettered_at = case when v_state = 'failed' then now() else null end
     where id = r.id;
    perform task_log(r.workspace_id, r.id, 'warn', 'Lease expired; task recovered',
      jsonb_build_object('previousOwner', r.lease_owner, 'state', v_state));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Atomic compare-and-set materialization; the app computes the following run
-- (cron/timezone math lives in lib/tasks/cron.ts). Concurrent ticks cannot
-- double-create: the CAS on next_run_at and the idempotency key both guard.
create or replace function materialize_schedule(p_schedule uuid, p_expected timestamptz, p_following timestamptz)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s task_schedules;
  v_task uuid;
begin
  if p_following <= p_expected then
    raise exception 'following run must be after the expected run' using errcode = '22023';
  end if;
  update task_schedules
     set next_run_at = p_following, last_run_at = p_expected
   where id = p_schedule and enabled and next_run_at = p_expected
  returning * into s;
  if not found then return null; end if;
  insert into tasks(workspace_id, campaign_id, kind, objective, execution_mode, input, schedule_id,
                    idempotency_key, next_run_at)
  values (s.workspace_id, s.campaign_id, s.kind, 'Scheduled: ' || s.name, s.execution_mode, s.input, s.id,
          'schedule:' || s.id || ':' || to_char(p_expected at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          greatest(p_expected, now()))
  on conflict (workspace_id, idempotency_key) do nothing
  returning id into v_task;
  if v_task is not null then
    perform task_log(s.workspace_id, v_task, 'info', 'Materialized from schedule', jsonb_build_object('scheduleId', s.id));
  end if;
  return v_task;
end $$;

-- ---------------------------------------------------------------------------
-- Operator RPCs (membership-checked)
-- ---------------------------------------------------------------------------
create or replace function approve_task(p_task uuid, p_approve boolean, p_note text default null)
returns text language plpgsql security definer set search_path = public as $$
declare t tasks;
begin
  select * into t from tasks where id = p_task for update;
  if not found or not is_workspace_owner(t.workspace_id) then
    raise exception 'task unavailable' using errcode = '42501';
  end if;
  if t.approval_state <> 'pending' or t.state in ('completed','failed','cancelled') then
    raise exception 'task is not awaiting approval' using errcode = '23514';
  end if;
  update tasks
     set approval_state = case when p_approve then 'approved' else 'rejected' end,
         approved_by = auth.uid(), approved_at = now(),
         state = case when p_approve then state else 'cancelled' end
   where id = t.id;
  perform task_log(t.workspace_id, t.id, 'info', case when p_approve then 'Approved' else 'Rejected' end,
    jsonb_build_object('note', left(coalesce(p_note, ''), 500)));
  insert into product_activity(workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (t.workspace_id, 'task', t.id, auth.uid(), case when p_approve then 'task.approved' else 'task.rejected' end,
          jsonb_build_object('kind', t.kind));
  return case when p_approve then 'approved' else 'rejected' end;
end $$;

create or replace function cancel_task(p_task uuid, p_reason text default null)
returns text language plpgsql security definer set search_path = public as $$
declare t tasks;
begin
  select * into t from tasks where id = p_task for update;
  if not found or not is_workspace_member(t.workspace_id) then
    raise exception 'task unavailable' using errcode = '42501';
  end if;
  if t.state in ('completed','failed','cancelled') then
    raise exception 'task already finished' using errcode = '23514';
  end if;
  update tasks set state = 'cancelled' where id = t.id;
  perform task_log(t.workspace_id, t.id, 'warn', 'Cancelled by operator',
    jsonb_build_object('reason', left(coalesce(p_reason, ''), 500), 'previousState', t.state));
  insert into product_activity(workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (t.workspace_id, 'task', t.id, auth.uid(), 'task.cancelled', jsonb_build_object('from', t.state));
  return 'cancelled';
end $$;

-- failed (dead letter) -> queued: owners only (re-executes external actions under the same idempotency key).
-- waiting_for_user -> queued: any member, after resolving the intervention.
create or replace function retry_task(p_task uuid, p_note text default null)
returns text language plpgsql security definer set search_path = public as $$
declare t tasks;
begin
  select * into t from tasks where id = p_task for update;
  if not found or not is_workspace_member(t.workspace_id) then
    raise exception 'task unavailable' using errcode = '42501';
  end if;
  if t.state = 'failed' then
    if not is_workspace_owner(t.workspace_id) then
      raise exception 'owner access required to retry failed tasks' using errcode = '42501';
    end if;
    update tasks set state = 'queued', attempts = 0, dead_lettered_at = null, next_run_at = now(), finished_at = null
     where id = t.id;
  elsif t.state = 'waiting_for_user' then
    update tasks set state = 'queued', human_intervention = 'resolved', next_run_at = now() where id = t.id;
  else
    raise exception 'only failed or waiting tasks can be retried' using errcode = '23514';
  end if;
  perform task_log(t.workspace_id, t.id, 'info', 'Re-queued by operator',
    jsonb_build_object('from', t.state, 'note', left(coalesce(p_note, ''), 500)));
  insert into product_activity(workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (t.workspace_id, 'task', t.id, auth.uid(), 'task.retried', jsonb_build_object('from', t.state));
  return 'queued';
end $$;

revoke all on function task_log(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function claim_tasks(text, text[], integer, integer, uuid, integer) from public, anon, authenticated;
revoke all on function heartbeat_task(uuid, text, integer) from public, anon, authenticated;
revoke all on function complete_task(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function fail_task(uuid, text, jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function defer_task(uuid, text, timestamptz, text) from public, anon, authenticated;
revoke all on function recover_expired_leases() from public, anon, authenticated;
revoke all on function materialize_schedule(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function task_transition_guard() from public, anon, authenticated;
revoke all on function task_schedule_touch() from public, anon, authenticated;
grant execute on function claim_tasks(text, text[], integer, integer, uuid, integer), heartbeat_task(uuid, text, integer),
  complete_task(uuid, text, jsonb), fail_task(uuid, text, jsonb, text, timestamptz),
  defer_task(uuid, text, timestamptz, text), recover_expired_leases(),
  materialize_schedule(uuid, timestamptz, timestamptz), task_log(uuid, uuid, text, text, jsonb) to service_role;

revoke all on function approve_task(uuid, boolean, text), cancel_task(uuid, text), retry_task(uuid, text) from public, anon;
grant execute on function approve_task(uuid, boolean, text), cancel_task(uuid, text), retry_task(uuid, text)
  to authenticated, service_role;

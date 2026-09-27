-- 00030 Tenant security hardening (audit findings S1, S2, S5, S6, S9).
-- Forward-only. See docs/architecture/SECURITY_THREAT_MODEL.md.
begin;

-- ---------------------------------------------------------------------------
-- S1: scheduled_jobs is a worker-only queue. 00009 let every authenticated
-- user read/insert/update every job across tenants, which allowed forged
-- gateway events and flow resumes to be executed by the service-role cron.
-- ---------------------------------------------------------------------------
alter table scheduled_jobs add column if not exists workspace_id uuid references workspaces(id) on delete cascade;

update scheduled_jobs j set workspace_id = w.id
from workspaces w
where j.workspace_id is null and j.type = 'resume_flow'
  and j.payload->>'workspaceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and w.id = (j.payload->>'workspaceId')::uuid;
update scheduled_jobs j set workspace_id = c.workspace_id
from channels c
where j.workspace_id is null and j.type = 'process_social_gateway_event' and j.payload->>'channelId' = c.id::text;
update scheduled_jobs j set workspace_id = b.workspace_id
from broadcast_recipients r join broadcasts b on b.id = r.broadcast_id
where j.workspace_id is null and j.type = 'send_broadcast' and j.payload->>'recipientId' = r.id::text;

create index if not exists scheduled_jobs_workspace_idx on scheduled_jobs(workspace_id, status);

create or replace function scheduled_job_workspace_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is null then
    if new.type = 'resume_flow'
       and new.payload->>'workspaceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      new.workspace_id := (new.payload->>'workspaceId')::uuid;
    elsif new.type = 'process_social_gateway_event' then
      select workspace_id into new.workspace_id from channels where id::text = new.payload->>'channelId';
    elsif new.type = 'send_broadcast' then
      select b.workspace_id into new.workspace_id
      from broadcast_recipients r join broadcasts b on b.id = r.broadcast_id
      where r.id::text = new.payload->>'recipientId';
    end if;
  end if;
  return new;
end $$;
revoke all on function scheduled_job_workspace_fill() from public, anon, authenticated;
create trigger scheduled_job_workspace_fill before insert on scheduled_jobs
  for each row execute function scheduled_job_workspace_fill();

drop policy if exists "Authenticated users can insert jobs" on scheduled_jobs;
drop policy if exists "Authenticated users can read jobs" on scheduled_jobs;
drop policy if exists "Authenticated users can update jobs" on scheduled_jobs;
alter table scheduled_jobs enable row level security;
revoke all on scheduled_jobs from anon, authenticated;

-- S9 + S1: broadcasts are scheduled by a membership-checked RPC instead of
-- browser-role inserts. Honors broadcasts.scheduled_for and is idempotent.
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
  insert into scheduled_jobs(type, payload, run_at, status, attempts, dedupe_key, workspace_id)
  select 'send_broadcast',
         jsonb_build_object('broadcastId', b.id, 'recipientId', r.id),
         first_run + ((row_number() over (order by r.id)) - 1) * interval '100 milliseconds',
         'pending', 0, 'broadcast:' || r.id, b.workspace_id
  from broadcast_recipients r
  where r.broadcast_id = b.id and r.status = 'pending'
  on conflict (type, dedupe_key) do nothing;
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
-- S6: legacy tables validated only the parent row's workspace. Enforce that
-- every referenced row belongs to the same workspace, for all writers.
-- ---------------------------------------------------------------------------
create or replace function workspace_consistency_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  expected uuid;
  bad boolean := false;
begin
  if TG_TABLE_NAME = 'sequence_enrollments' then
    select workspace_id into expected from sequences where id = new.sequence_id;
    bad := (select workspace_id from contacts where id = new.contact_id) is distinct from expected
        or (select workspace_id from channels where id = new.channel_id) is distinct from expected;
  elsif TG_TABLE_NAME = 'broadcast_recipients' then
    select workspace_id into expected from broadcasts where id = new.broadcast_id;
    bad := (select workspace_id from contacts where id = new.contact_id) is distinct from expected
        or (select workspace_id from channels where id = new.channel_id) is distinct from expected;
  elsif TG_TABLE_NAME = 'contact_channels' then
    select workspace_id into expected from contacts where id = new.contact_id;
    bad := (select workspace_id from channels where id = new.channel_id) is distinct from expected;
  elsif TG_TABLE_NAME = 'contact_tags' then
    select workspace_id into expected from contacts where id = new.contact_id;
    bad := (select workspace_id from tags where id = new.tag_id) is distinct from expected;
  elsif TG_TABLE_NAME = 'contact_custom_fields' then
    select workspace_id into expected from contacts where id = new.contact_id;
    bad := (select workspace_id from custom_field_definitions where id = new.field_id) is distinct from expected;
  elsif TG_TABLE_NAME = 'conversations' then
    expected := new.workspace_id;
    bad := (select workspace_id from channels where id = new.channel_id) is distinct from expected
        or (select workspace_id from contacts where id = new.contact_id) is distinct from expected;
  elsif TG_TABLE_NAME = 'triggers' then
    select workspace_id into expected from flows where id = new.flow_id;
    bad := new.channel_id is not null
       and (select workspace_id from channels where id = new.channel_id) is distinct from expected;
  end if;
  if expected is null or bad then
    raise exception 'referenced records must belong to the same workspace' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function workspace_consistency_guard() from public, anon, authenticated;

create trigger workspace_consistency before insert or update of sequence_id, contact_id, channel_id
  on sequence_enrollments for each row execute function workspace_consistency_guard();
create trigger workspace_consistency before insert or update of broadcast_id, contact_id, channel_id
  on broadcast_recipients for each row execute function workspace_consistency_guard();
create trigger workspace_consistency before insert or update of contact_id, channel_id
  on contact_channels for each row execute function workspace_consistency_guard();
create trigger workspace_consistency before insert or update of contact_id, tag_id
  on contact_tags for each row execute function workspace_consistency_guard();
create trigger workspace_consistency before insert or update of contact_id, field_id
  on contact_custom_fields for each row execute function workspace_consistency_guard();
create trigger workspace_consistency before insert or update of workspace_id, channel_id, contact_id
  on conversations for each row execute function workspace_consistency_guard();
create trigger workspace_consistency before insert or update of flow_id, channel_id
  on triggers for each row execute function workspace_consistency_guard();

-- ---------------------------------------------------------------------------
-- S5: legacy plaintext secret columns are not readable or writable by browser
-- roles. Server code (service role) keeps access until values are imported
-- into the secret store and the columns are dropped in a later migration.
-- ---------------------------------------------------------------------------
revoke select, insert, update on workspaces from anon, authenticated;
grant select (id, name, slug, global_keywords, ai_provider, created_at, updated_at) on workspaces to authenticated;
grant insert (name, slug, global_keywords) on workspaces to authenticated;
grant update (name, global_keywords, ai_provider) on workspaces to authenticated;

revoke select, insert, update on channels from anon, authenticated;
grant select (id, workspace_id, platform, late_account_id, username, display_name, profile_picture, webhook_id,
              is_active, created_at, updated_at, last_comment_cursor, comment_rules) on channels to authenticated;
-- No client INSERT: channel rows are Gateway projections written server-side
-- only after the gateway workspace binding check (a client-chosen
-- late_account_id would otherwise capture another tenant's webhooks).
grant update (platform, username, display_name, profile_picture, is_active, comment_rules) on channels to authenticated;

-- ---------------------------------------------------------------------------
-- S2: a deployment-level Agent Social Gateway workspace may be projected into
-- exactly one ZernFlow workspace. Bindings are operator/service managed.
-- ---------------------------------------------------------------------------
create table gateway_workspace_bindings (
  gateway_workspace_ref text primary key check (length(trim(gateway_workspace_ref)) between 1 and 200),
  workspace_id uuid not null unique references workspaces(id) on delete cascade,
  created_by text not null default 'operator' check (length(created_by) <= 200),
  created_at timestamptz not null default now()
);
alter table gateway_workspace_bindings enable row level security;
create policy member_read on gateway_workspace_bindings for select to authenticated
  using (is_workspace_member(workspace_id));
revoke insert, update, delete on gateway_workspace_bindings from anon, authenticated;

-- Preserve current single-tenant production behavior: when exactly one
-- workspace already projects Gateway channels, bind it as the deployment
-- default. Multiple projecting workspaces require explicit operator choice.
insert into gateway_workspace_bindings(gateway_workspace_ref, workspace_id, created_by)
select '__deployment__', min(workspace_id::text)::uuid, 'migration:00030'
from channels
having count(distinct workspace_id) = 1;

do $$
begin
  if exists (select 1 from channels group by late_account_id having count(distinct workspace_id) > 1) then
    raise warning 'ZernFlow 00030: a gateway account is projected into multiple workspaces; unique projection index not created. Resolve duplicates and create channels_gateway_account_single_projection manually.';
  else
    create unique index channels_gateway_account_single_projection on channels(late_account_id);
  end if;
end $$;

comment on table gateway_workspace_bindings is
  'Binds a deployment Agent Social Gateway workspace ref to exactly one ZernFlow workspace (tenant isolation).';
commit;

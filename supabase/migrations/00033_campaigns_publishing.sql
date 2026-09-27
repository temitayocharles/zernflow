-- 00033: Campaign OS and per-channel publishing state.
-- See docs/architecture/DOMAIN_MODEL.md (Campaign, Content item, Publish state machine).
--
-- Consolidation rather than duplication: content items remain editorial_drafts
-- and channel variants remain editorial_variants, extended with campaign links
-- and publish state. Publishing runs through durable tasks (00031); browser
-- clients can never set publish state or external references directly.

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
create table campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  objective text not null default 'engagement' check (objective in (
    'awareness','engagement','lead_generation','sales','launch','community','other')),
  status text not null default 'draft' check (status in ('draft','planned','active','paused','completed','archived')),
  owner_id uuid,
  audience jsonb not null default '{}'::jsonb check (jsonb_typeof(audience) = 'object' and pg_column_size(audience) <= 16384),
  channel_ids uuid[] not null default '{}'::uuid[] check (cardinality(channel_ids) <= 50),
  voice text not null default '' check (length(voice) <= 20000),
  content_plan jsonb not null default '{}'::jsonb check (jsonb_typeof(content_plan) = 'object' and pg_column_size(content_plan) <= 65536),
  utm_defaults jsonb not null default '{}'::jsonb check (jsonb_typeof(utm_defaults) = 'object' and pg_column_size(utm_defaults) <= 4096),
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text not null default 'UTC' check (length(timezone) between 1 and 100),
  requires_approval boolean not null default true,
  results jsonb not null default '{}'::jsonb check (jsonb_typeof(results) = 'object' and pg_column_size(results) <= 65536),
  notes text not null default '' check (length(notes) <= 20000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (workspace_id, id),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  foreign key (workspace_id, owner_id) references workspace_members(workspace_id, user_id) on delete set null (owner_id)
);
create index campaigns_workspace_idx on campaigns(workspace_id, status, created_at desc);

create or replace function campaign_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'UPDATE' then
    if new.id <> old.id or new.workspace_id <> old.workspace_id or new.created_at <> old.created_at then
      raise exception 'campaign identity is immutable' using errcode = '23514';
    end if;
    -- results are written by server-side analytics only.
    if new.results is distinct from old.results and current_user in ('authenticated', 'anon') then
      raise exception 'campaign results are server-managed' using errcode = '42501';
    end if;
    new.version := old.version + 1;
    new.updated_at := now();
  elsif current_user in ('authenticated', 'anon') then
    new.results := '{}'::jsonb;
  end if;
  if cardinality(new.channel_ids) > 0 and exists (
    select 1 from unnest(new.channel_ids) c(id)
    where not exists (select 1 from channels ch where ch.id = c.id and ch.workspace_id = new.workspace_id)
  ) then
    raise exception 'campaign channels must belong to the workspace' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger campaign_guard before insert or update on campaigns for each row execute function campaign_guard();
create trigger record_audit after insert or update on campaigns for each row execute function product_record_audit();

alter table campaigns enable row level security;
revoke all on campaigns from anon, authenticated;
grant select, insert, update on campaigns to authenticated;
create policy member_read on campaigns for select to authenticated using (is_workspace_member(workspace_id));
create policy member_create on campaigns for insert to authenticated with check (is_workspace_member(workspace_id));
create policy member_update on campaigns for update to authenticated
  using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));
-- No delete grant: campaigns are archived, preserving attribution history.

-- Task and artifact links to campaigns (tables from 00031 / 00032).
alter table tasks add constraint tasks_campaign_fk
  foreign key (workspace_id, campaign_id) references campaigns(workspace_id, id) on delete set null (campaign_id);
alter table artifacts add constraint artifacts_campaign_fk
  foreign key (workspace_id, campaign_id) references campaigns(workspace_id, id) on delete set null (campaign_id);

-- ---------------------------------------------------------------------------
-- Content items (editorial_drafts) — campaign link, kind, tracked link, assets
-- ---------------------------------------------------------------------------
alter table editorial_drafts
  add column campaign_id uuid,
  add column kind text not null default 'post' check (kind in ('post','short_video','story','thread','article','reel','carousel')),
  add column link_url text check (link_url is null or (length(link_url) <= 2000 and link_url ~ '^https?://')),
  add column utm jsonb not null default '{}'::jsonb check (jsonb_typeof(utm) = 'object' and pg_column_size(utm) <= 4096),
  add column asset_ids uuid[] not null default '{}'::uuid[] check (cardinality(asset_ids) <= 20),
  add column created_by uuid references auth.users(id) on delete set null,
  add constraint editorial_drafts_campaign_fk
    foreign key (workspace_id, campaign_id) references campaigns(workspace_id, id) on delete set null (campaign_id);
create index editorial_drafts_campaign_idx on editorial_drafts(workspace_id, campaign_id) where campaign_id is not null;

-- Backfill: the free-text `campaign` label becomes a real campaign per workspace.
insert into campaigns (workspace_id, name, status, requires_approval, notes)
select distinct d.workspace_id, left(trim(d.campaign), 200), 'active', true, 'Created from the legacy editorial campaign label.'
  from editorial_drafts d
 where trim(d.campaign) <> '';
update editorial_drafts d
   set campaign_id = c.id
  from campaigns c
 where c.workspace_id = d.workspace_id and c.name = left(trim(d.campaign), 200) and trim(d.campaign) <> ''
   and c.notes = 'Created from the legacy editorial campaign label.';

-- ---------------------------------------------------------------------------
-- Channel variants (editorial_variants) — publish state
-- ---------------------------------------------------------------------------
alter table editorial_variants
  add column publish_state text not null default 'draft' check (publish_state in (
    'draft','scheduled','queued','publishing','published','failed','cancelled')),
  add column scheduled_at timestamptz,
  add column execution_mode text check (execution_mode is null or execution_mode in ('api','browser','manual')),
  add column idempotency_key text check (idempotency_key is null or length(idempotency_key) <= 300),
  add column task_id uuid,
  add column external_ref text check (external_ref is null or length(external_ref) <= 300),
  add column external_url text check (external_url is null or (length(external_url) <= 2000 and external_url ~ '^https://')),
  add column published_at timestamptz,
  add column last_error text check (last_error is null or length(last_error) <= 1000),
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add constraint editorial_variants_task_fk
    foreign key (workspace_id, task_id) references tasks(workspace_id, id) on delete set null (task_id),
  add constraint editorial_variants_scheduled_has_time
    check (publish_state not in ('scheduled','queued','publishing') or (scheduled_at is not null and execution_mode is not null));
create index editorial_variants_calendar_idx on editorial_variants(workspace_id, scheduled_at) where scheduled_at is not null;
create index editorial_variants_active_idx on editorial_variants(publish_state) where publish_state in ('scheduled','queued','publishing');

create or replace function variant_publish_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  client boolean := current_user in ('authenticated', 'anon');
  allowed boolean;
begin
  if TG_OP = 'INSERT' then
    -- New variants always start as drafts regardless of who inserts them.
    new.publish_state := 'draft';
    new.scheduled_at := null; new.execution_mode := null; new.idempotency_key := null; new.task_id := null;
    new.external_ref := null; new.external_url := null; new.published_at := null; new.last_error := null;
    new.attempt_count := 0;
    return new;
  end if;

  if client and (
       new.publish_state <> old.publish_state or new.scheduled_at is distinct from old.scheduled_at
    or new.execution_mode is distinct from old.execution_mode or new.idempotency_key is distinct from old.idempotency_key
    or new.task_id is distinct from old.task_id or new.external_ref is distinct from old.external_ref
    or new.external_url is distinct from old.external_url or new.published_at is distinct from old.published_at
    or new.last_error is distinct from old.last_error or new.attempt_count <> old.attempt_count) then
    raise exception 'publish state is managed by the scheduler' using errcode = '42501';
  end if;

  if (new.body <> old.body or new.media_refs <> old.media_refs)
     and old.publish_state in ('scheduled','queued','publishing','published') then
    raise exception 'unschedule this variant before editing it' using errcode = '23514';
  end if;

  if new.publish_state <> old.publish_state then
    allowed := case old.publish_state
      when 'draft' then new.publish_state in ('scheduled')
      when 'scheduled' then new.publish_state in ('draft','queued','publishing','cancelled','failed')
      when 'queued' then new.publish_state in ('draft','publishing','cancelled','failed')
      when 'publishing' then new.publish_state in ('published','failed','queued','cancelled')
      when 'failed' then new.publish_state in ('draft','scheduled','cancelled')
      when 'cancelled' then new.publish_state in ('draft','scheduled')
      else false
    end;
    if not allowed then
      raise exception 'illegal publish transition % -> %', old.publish_state, new.publish_state using errcode = '23514';
    end if;
    if new.publish_state = 'published' then
      new.published_at := coalesce(new.published_at, now());
    end if;
  end if;
  return new;
end $$;
-- Named to sort before variant_guard (00024), which resets draft approval after changes.
create trigger variant_publish_guard before insert or update on editorial_variants
  for each row execute function variant_publish_guard();

-- The approval-invalidation trigger from 00024 must not fire for scheduler-only
-- state changes (it would reset the content item's approval on every publish).
create or replace function editorial_variant_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'UPDATE' and (new.draft_id <> old.draft_id or new.channel_id <> old.channel_id) then
    raise exception 'variant identity immutable' using errcode = '23514';
  end if;
  if TG_OP = 'INSERT' or new.body <> old.body or new.media_refs <> old.media_refs then
    update editorial_drafts set state = 'draft' where workspace_id = new.workspace_id and id = new.draft_id;
  end if;
  return new;
end $$;
revoke all on function editorial_variant_guard() from public;

-- Content edits are locked while any variant is scheduled or in flight, and
-- changes to the tracked link or assets invalidate approval like body edits do.
create or replace function content_schedule_lock() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.body <> old.body or new.name <> old.name or new.link_url is distinct from old.link_url
      or new.utm <> old.utm or new.asset_ids <> old.asset_ids or new.kind <> old.kind)
  then
    if exists (select 1 from editorial_variants v where v.draft_id = new.id
               and v.publish_state in ('scheduled','queued','publishing')) then
      raise exception 'unschedule this content before editing it' using errcode = '23514';
    end if;
    if new.link_url is distinct from old.link_url or new.utm <> old.utm or new.asset_ids <> old.asset_ids or new.kind <> old.kind then
      new.state := 'draft';
    end if;
  end if;
  if cardinality(new.asset_ids) > 0 and exists (
    select 1 from unnest(new.asset_ids) a(id)
    where not exists (select 1 from artifacts ar where ar.id = a.id and ar.workspace_id = new.workspace_id and ar.status = 'available')
  ) then
    raise exception 'content assets must be available artifacts of this workspace' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger content_schedule_lock before update on editorial_drafts
  for each row execute function content_schedule_lock();

create or replace function content_asset_check() returns trigger
language plpgsql set search_path = public as $$
begin
  if cardinality(new.asset_ids) > 0 and exists (
    select 1 from unnest(new.asset_ids) a(id)
    where not exists (select 1 from artifacts ar where ar.id = a.id and ar.workspace_id = new.workspace_id and ar.status = 'available')
  ) then
    raise exception 'content assets must be available artifacts of this workspace' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger content_asset_check before insert on editorial_drafts
  for each row execute function content_asset_check();

-- ---------------------------------------------------------------------------
-- Scheduling RPCs (members; approval policy enforced here)
-- ---------------------------------------------------------------------------
-- p_plan: [{"variantId": uuid, "mode": "api"|"browser"|"manual"}]. The app
-- resolves modes from channel capabilities; handlers re-check capability at
-- execution time, so a forged mode can only fail safely.
create or replace function schedule_content_item(p_draft uuid, p_at timestamptz, p_plan jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  d editorial_drafts;
  c campaigns;
  item jsonb;
  v editorial_variants;
  v_mode text;
  v_key text;
  v_task uuid;
  v_count integer := 0;
  v_at timestamptz;
begin
  select * into d from editorial_drafts where id = p_draft for update;
  if not found or not is_workspace_member(d.workspace_id) then
    raise exception 'content unavailable' using errcode = '42501';
  end if;
  if d.campaign_id is not null then
    select * into c from campaigns where id = d.campaign_id;
  end if;
  if (c.id is not null and c.requires_approval and d.state <> 'approved')
     or (d.state <> 'approved' and not is_workspace_owner(d.workspace_id)) then
    raise exception 'owner approval is required before scheduling' using errcode = '42501';
  end if;
  if c.id is not null and c.status in ('completed','archived') then
    raise exception 'campaign is closed' using errcode = '23514';
  end if;
  v_at := coalesce(p_at, d.scheduled_at, now());
  if v_at < now() - interval '5 minutes' then
    raise exception 'schedule time is in the past' using errcode = '23514';
  end if;
  if jsonb_typeof(p_plan) <> 'array' or jsonb_array_length(p_plan) = 0 or jsonb_array_length(p_plan) > 50 then
    raise exception 'plan must list 1-50 variants' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(p_plan) loop
    v_mode := item->>'mode';
    if v_mode not in ('api','browser','manual') then
      raise exception 'invalid execution mode' using errcode = '22023';
    end if;
    select * into v from editorial_variants
     where id = (item->>'variantId')::uuid and draft_id = d.id and workspace_id = d.workspace_id for update;
    if not found then
      raise exception 'variant not found' using errcode = '22023';
    end if;
    if v.publish_state not in ('draft','failed','cancelled') then
      raise exception 'variant is already scheduled or published' using errcode = '23514';
    end if;
    v_key := 'publish:' || v.id || ':v' || v.version || ':' || extract(epoch from v_at)::bigint;
    insert into tasks (workspace_id, campaign_id, kind, objective, execution_mode, next_run_at, idempotency_key,
                       input, subject_type, subject_id, created_by, retry_policy)
    values (d.workspace_id, d.campaign_id, 'content.publish',
            left('Publish "' || d.name || '" to channel', 500),
            case v_mode when 'manual' then 'human' else v_mode end,
            v_at, v_key,
            jsonb_build_object('variantId', v.id, 'draftId', d.id, 'channelId', v.channel_id,
                               'variantVersion', v.version, 'mode', v_mode),
            'editorial_variants', v.id, auth.uid(),
            '{"maxAttempts":3,"baseDelayMs":60000,"maxDelayMs":1800000}'::jsonb)
    on conflict (workspace_id, idempotency_key) do nothing
    returning id into v_task;
    if v_task is null then
      select id into v_task from tasks where workspace_id = d.workspace_id and idempotency_key = v_key;
    end if;
    update editorial_variants
       set publish_state = 'scheduled', scheduled_at = v_at, execution_mode = v_mode,
           idempotency_key = v_key, task_id = v_task, last_error = null
     where id = v.id;
    perform task_log(d.workspace_id, v_task, 'info', 'Scheduled for ' || to_char(v_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC',
                     jsonb_build_object('mode', v_mode, 'channelId', v.channel_id));
    v_count := v_count + 1;
  end loop;

  insert into product_activity(workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (d.workspace_id, 'editorial_drafts', d.id, auth.uid(), 'content.scheduled',
          jsonb_build_object('variants', v_count, 'at', v_at));
  return v_count;
end $$;

-- Returns scheduled/queued/failed variants to draft and cancels their tasks.
-- Variants already publishing cannot be pulled back (outcome unknown).
create or replace function unschedule_content_item(p_draft uuid, p_variant uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  d editorial_drafts;
  v editorial_variants;
  v_count integer := 0;
begin
  select * into d from editorial_drafts where id = p_draft;
  if not found or not is_workspace_member(d.workspace_id) then
    raise exception 'content unavailable' using errcode = '42501';
  end if;
  for v in select * from editorial_variants
            where draft_id = d.id and workspace_id = d.workspace_id
              and (p_variant is null or id = p_variant)
              and publish_state in ('scheduled','queued','failed','cancelled')
            for update loop
    if v.task_id is not null then
      update tasks set state = 'cancelled'
       where id = v.task_id and state in ('queued','retrying','waiting','waiting_for_user');
      perform task_log(d.workspace_id, v.task_id, 'warn', 'Unscheduled by operator', '{}'::jsonb);
    end if;
    update editorial_variants
       set publish_state = 'draft', scheduled_at = null, execution_mode = null, idempotency_key = null, task_id = null
     where id = v.id;
    v_count := v_count + 1;
  end loop;
  insert into product_activity(workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (d.workspace_id, 'editorial_drafts', d.id, auth.uid(), 'content.unscheduled', jsonb_build_object('variants', v_count));
  return v_count;
end $$;

-- Operator confirms a manual publication (execution_mode = manual).
create or replace function confirm_manual_publication(p_variant uuid, p_external_url text, p_external_ref text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  v editorial_variants;
  t tasks;
  v_owner text := 'human:' || coalesce(auth.uid()::text, 'unknown');
begin
  select * into v from editorial_variants where id = p_variant for update;
  if not found or not is_workspace_member(v.workspace_id) then
    raise exception 'variant unavailable' using errcode = '42501';
  end if;
  if v.execution_mode is distinct from 'manual' or v.publish_state not in ('scheduled','queued','failed') then
    raise exception 'only scheduled manual variants can be confirmed' using errcode = '23514';
  end if;
  if p_external_url is null or p_external_url !~ '^https://' or length(p_external_url) > 2000 then
    raise exception 'a https link to the published post is required' using errcode = '22023';
  end if;
  if v.task_id is not null then
    select * into t from tasks where id = v.task_id for update;
    if found and t.state in ('queued','waiting_for_user') then
      if t.state = 'waiting_for_user' then
        update tasks set state = 'queued' where id = t.id;
      end if;
      update tasks set state = 'running', attempts = attempts + 1, lease_owner = v_owner,
                       lease_expires_at = now() + interval '1 minute', started_at = coalesce(started_at, now())
       where id = t.id;
      update tasks set state = 'completed', result = jsonb_build_object('externalUrl', p_external_url, 'confirmedBy', auth.uid()),
                       human_intervention = case when human_intervention = 'none' then 'none' else 'resolved' end
       where id = t.id;
      perform task_log(v.workspace_id, t.id, 'info', 'Publication confirmed by operator', jsonb_build_object('url', p_external_url));
    end if;
  end if;
  if v.publish_state = 'failed' then
    update editorial_variants set publish_state = 'scheduled' where id = v.id;
  end if;
  update editorial_variants set publish_state = 'publishing' where id = v.id;
  update editorial_variants
     set publish_state = 'published', external_url = p_external_url,
         external_ref = left(p_external_ref, 300), published_at = now(), last_error = null,
         attempt_count = attempt_count + 1
   where id = v.id;
  insert into product_activity(workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (v.workspace_id, 'editorial_variants', v.id, auth.uid(), 'content.published_manually', jsonb_build_object('url', p_external_url));
  return 'published';
end $$;

revoke all on function campaign_guard(), variant_publish_guard(), content_schedule_lock(), content_asset_check() from public, anon, authenticated;
revoke all on function schedule_content_item(uuid, timestamptz, jsonb), unschedule_content_item(uuid, uuid),
  confirm_manual_publication(uuid, text, text) from public, anon;
grant execute on function schedule_content_item(uuid, timestamptz, jsonb), unschedule_content_item(uuid, uuid),
  confirm_manual_publication(uuid, text, text) to authenticated, service_role;

-- Notifications may point at content items.
alter table operator_notifications drop constraint if exists operator_notifications_entity_type_check;
alter table operator_notifications add constraint operator_notifications_entity_type_check check (entity_type in (
  'work_items','companies','contacts','deals','conversations',
  'secrets','tasks','browser_sessions','campaigns','artifacts','editorial_drafts'));

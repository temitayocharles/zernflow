-- R9: campaign attribution (touchpoints → contact first/last touch → campaign) and
-- lead intake endpoints. Forward-only; no historical migration is modified.

-- ---------------------------------------------------------------------------
-- Touchpoints: every attributable interaction between a contact and the workspace
-- ---------------------------------------------------------------------------
create table contact_touchpoints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid not null,
  campaign_id uuid,
  variant_id uuid,
  channel_id uuid,
  source text not null check (source in ('comment', 'dm', 'form', 'link', 'manual', 'import')),
  utm jsonb not null default '{}'::jsonb check (jsonb_typeof(utm) = 'object' and pg_column_size(utm) <= 2048),
  external_ref text check (external_ref is null or length(external_ref) <= 300),
  landing_url text check (landing_url is null or (length(landing_url) <= 2000 and landing_url ~ '^https?://')),
  note text not null default '' check (length(note) <= 1000),
  dedupe_key text check (dedupe_key is null or length(dedupe_key) between 1 and 200),
  occurred_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, dedupe_key),
  foreign key (workspace_id, contact_id) references contacts(workspace_id, id) on delete cascade,
  foreign key (workspace_id, campaign_id) references campaigns(workspace_id, id) on delete set null (campaign_id),
  foreign key (workspace_id, variant_id) references editorial_variants(workspace_id, id) on delete set null (variant_id),
  foreign key (workspace_id, channel_id) references channels(workspace_id, id) on delete set null (channel_id)
);
create index contact_touchpoints_contact_idx on contact_touchpoints(workspace_id, contact_id, occurred_at desc);
create index contact_touchpoints_campaign_idx on contact_touchpoints(workspace_id, campaign_id, occurred_at desc) where campaign_id is not null;

alter table contact_touchpoints enable row level security;
revoke all on contact_touchpoints from anon, authenticated;
grant select, insert on contact_touchpoints to authenticated;
grant delete on contact_touchpoints to authenticated;
create policy member_read on contact_touchpoints for select to authenticated using (is_workspace_member(workspace_id));
-- Members may only record manual touchpoints as themselves; automatic sources are service-written.
create policy member_manual_insert on contact_touchpoints for insert to authenticated
  with check (is_workspace_member(workspace_id) and source = 'manual' and created_by = auth.uid() and dedupe_key is null);
create policy owner_delete on contact_touchpoints for delete to authenticated
  using (exists (select 1 from workspace_members m where m.workspace_id = contact_touchpoints.workspace_id and m.user_id = auth.uid() and m.role = 'owner'));

-- Published posts are looked up by provider post id when comments arrive.
create index editorial_variants_external_ref_idx on editorial_variants(workspace_id, channel_id, external_ref) where external_ref is not null;

-- ---------------------------------------------------------------------------
-- Contact attribution summary (system-maintained; CRM lead source stays in
-- customer_profiles.source and is editable there)
-- ---------------------------------------------------------------------------
alter table contacts
  add column first_touch_source text not null default '' check (length(first_touch_source) <= 200),
  add column first_touch_at timestamptz,
  add column last_touch_at timestamptz,
  add column first_campaign_id uuid,
  add column last_campaign_id uuid,
  add constraint contacts_first_campaign_fk foreign key (workspace_id, first_campaign_id) references campaigns(workspace_id, id) on delete set null (first_campaign_id),
  add constraint contacts_last_campaign_fk foreign key (workspace_id, last_campaign_id) references campaigns(workspace_id, id) on delete set null (last_campaign_id);
create index contacts_first_campaign_idx on contacts(workspace_id, first_campaign_id) where first_campaign_id is not null;
create index contacts_last_campaign_idx on contacts(workspace_id, last_campaign_id) where last_campaign_id is not null;

-- Clients cannot forge attribution; only the touchpoint trigger (definer) maintains it.
create or replace function contacts_attribution_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.first_touch_source := old.first_touch_source;
    new.first_touch_at := old.first_touch_at;
    new.last_touch_at := old.last_touch_at;
    new.first_campaign_id := old.first_campaign_id;
    new.last_campaign_id := old.last_campaign_id;
  end if;
  return new;
end $$;
create trigger contacts_attribution_guard before update on contacts
  for each row execute function contacts_attribution_guard();

create or replace function contacts_attribution_insert_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.first_touch_source := ''; new.first_touch_at := null; new.last_touch_at := null;
    new.first_campaign_id := null; new.last_campaign_id := null;
  end if;
  return new;
end $$;
create trigger contacts_attribution_insert_guard before insert on contacts
  for each row execute function contacts_attribution_insert_guard();

create or replace function apply_contact_touchpoint() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  label text := new.source || coalesce(' · ' || nullif(left(new.utm->>'utm_source', 60), ''), '');
begin
  update contacts c set
    first_touch_source = case when c.first_touch_at is null or new.occurred_at < c.first_touch_at then label else c.first_touch_source end,
    first_touch_at = least(coalesce(c.first_touch_at, new.occurred_at), new.occurred_at),
    last_touch_at = greatest(coalesce(c.last_touch_at, new.occurred_at), new.occurred_at),
    first_campaign_id = coalesce(c.first_campaign_id, new.campaign_id),
    last_campaign_id = case when new.campaign_id is not null and (c.last_touch_at is null or new.occurred_at >= c.last_touch_at)
                            then new.campaign_id else c.last_campaign_id end
  where c.id = new.contact_id and c.workspace_id = new.workspace_id;
  return new;
end $$;
revoke all on function apply_contact_touchpoint() from public;
create trigger contact_touchpoints_apply after insert on contact_touchpoints
  for each row execute function apply_contact_touchpoint();

-- ---------------------------------------------------------------------------
-- Campaign engagement (comments on a campaign's published posts + attributed leads)
-- Security invoker: RLS on the underlying tables scopes results to the caller.
-- ---------------------------------------------------------------------------
create or replace function campaign_engagement(p_workspace uuid, p_since timestamptz default now() - interval '30 days')
returns table (campaign_id uuid, comments bigint, commenters bigint, touchpoints bigint, contacts bigint, first_touch_contacts bigint)
language sql stable security invoker set search_path = public as $$
  with posts as (
    select d.campaign_id, v.channel_id, v.external_ref
      from editorial_variants v join editorial_drafts d on d.id = v.draft_id and d.workspace_id = v.workspace_id
     where v.workspace_id = p_workspace and v.external_ref is not null and d.campaign_id is not null
  ), c as (
    select p.campaign_id, count(*) as comments, count(distinct coalesce(cl.author_id, cl.author_username, cl.id::text)) as commenters
      from comment_logs cl join posts p on p.channel_id = cl.channel_id and p.external_ref = cl.post_id
     where cl.workspace_id = p_workspace and cl.created_at >= p_since
     group by p.campaign_id
  ), t as (
    select tp.campaign_id, count(*) as touchpoints, count(distinct tp.contact_id) as contacts
      from contact_touchpoints tp
     where tp.workspace_id = p_workspace and tp.campaign_id is not null and tp.occurred_at >= p_since
     group by tp.campaign_id
  ), f as (
    select ct.first_campaign_id as campaign_id, count(*) as first_touch_contacts
      from contacts ct
     where ct.workspace_id = p_workspace and ct.first_campaign_id is not null and ct.first_touch_at >= p_since
     group by ct.first_campaign_id
  )
  select k.campaign_id, coalesce(c.comments, 0), coalesce(c.commenters, 0), coalesce(t.touchpoints, 0), coalesce(t.contacts, 0), coalesce(f.first_touch_contacts, 0)
    from (select campaign_id from c union select campaign_id from t union select campaign_id from f) k
    left join c on c.campaign_id = k.campaign_id
    left join t on t.campaign_id = k.campaign_id
    left join f on f.campaign_id = k.campaign_id;
$$;
revoke all on function campaign_engagement(uuid, timestamptz) from public, anon;
grant execute on function campaign_engagement(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Lead intake endpoints: server-to-server tokens (only the SHA-256 is stored)
-- ---------------------------------------------------------------------------
create table lead_intake_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  default_campaign_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  foreign key (workspace_id, default_campaign_id) references campaigns(workspace_id, id) on delete set null (default_campaign_id)
);
create index lead_intake_tokens_workspace_idx on lead_intake_tokens(workspace_id);
alter table lead_intake_tokens enable row level security;
revoke all on lead_intake_tokens from anon, authenticated;
-- Owners see metadata only; the hash is never granted to clients. Writes go through the service role.
grant select (id, workspace_id, name, default_campaign_id, created_by, created_at, last_used_at, revoked_at) on lead_intake_tokens to authenticated;
create policy owner_read on lead_intake_tokens for select to authenticated
  using (exists (select 1 from workspace_members m where m.workspace_id = lead_intake_tokens.workspace_id and m.user_id = auth.uid() and m.role = 'owner'));

create or replace function lead_intake_token_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.token_hash <> old.token_hash or new.workspace_id <> old.workspace_id then
    raise exception 'lead intake token identity is immutable' using errcode = '42501';
  end if;
  if old.revoked_at is not null and new.revoked_at is null then
    raise exception 'revoked lead intake tokens cannot be restored' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger lead_intake_token_guard before update on lead_intake_tokens
  for each row execute function lead_intake_token_guard();

-- ZernFlow-owned customer domain; no provider events/messages/credentials duplicated.
begin;
alter table contacts add constraint contacts_workspace_id_id_key unique (workspace_id, id);
alter table conversations add constraint conversations_workspace_id_id_key unique (workspace_id, id);

create table companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  domain text not null default '' check (length(domain) <= 253),
  description text not null default '' check (length(description) <= 10000),
  owner_id uuid,
  lifecycle text not null default 'lead' check (lifecycle in ('lead','qualified','customer','inactive')),
  source text not null default '' check (length(source) <= 200),
  version integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(workspace_id,id),
  foreign key (workspace_id, owner_id) references workspace_members(workspace_id,user_id)
);
create index companies_workspace_name_idx on companies(workspace_id, name);
create table customer_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid not null,
  company_id uuid,
  owner_id uuid,
  lifecycle text not null default 'lead' check (lifecycle in ('lead','qualified','customer','inactive')),
  source text not null default '' check (length(source) <= 200),
  lead_score integer not null default 0 check (lead_score between 0 and 100),
  version integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(workspace_id,id), unique(workspace_id,contact_id),
  foreign key(workspace_id,contact_id) references contacts(workspace_id,id) on delete cascade,
  foreign key(workspace_id,company_id) references companies(workspace_id,id),
  foreign key(workspace_id,owner_id) references workspace_members(workspace_id,user_id)
);
create index customer_profiles_company_idx on customer_profiles(workspace_id,company_id);
create table deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  description text not null default '' check (length(description) <= 10000),
  company_id uuid, contact_id uuid, owner_id uuid,
  stage text not null default 'new' check(stage in ('new','qualified','proposal','negotiation','won','lost')),
  value_minor bigint not null default 0 check(value_minor between 0 and 9007199254740991),
  currency text not null default 'USD' check(currency ~ '^[A-Z]{3}$'),
  expected_close_at timestamptz,
  closed_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(workspace_id,id),
  foreign key(workspace_id,company_id) references companies(workspace_id,id),
  foreign key(workspace_id,contact_id) references contacts(workspace_id,id),
  foreign key(workspace_id,owner_id) references workspace_members(workspace_id,user_id)
);
create index deals_workspace_stage_idx on deals(workspace_id,stage,updated_at desc);
create table customer_notes (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id) on delete cascade,
  company_id uuid, contact_id uuid, deal_id uuid,
  body text not null check(length(trim(body)) between 1 and 10000),
  author_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  check(num_nonnulls(company_id,contact_id,deal_id)=1),
  foreign key(workspace_id,company_id) references companies(workspace_id,id) on delete cascade,
  foreign key(workspace_id,contact_id) references contacts(workspace_id,id) on delete cascade,
  foreign key(workspace_id,deal_id) references deals(workspace_id,id) on delete cascade
);
create index customer_notes_workspace_created_idx on customer_notes(workspace_id,created_at desc);
create table product_activity (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type text not null, entity_id uuid not null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null, changes jsonb not null default '{}', created_at timestamptz not null default now()
);
create index product_activity_entity_idx on product_activity(workspace_id,entity_type,entity_id,created_at desc);

-- Identity/timestamps cannot be rewritten via direct browser PostgREST calls.
create function product_record_guard() returns trigger language plpgsql set search_path=public as $$
begin
  if TG_OP='UPDATE' then
    if new.id<>old.id or new.workspace_id<>old.workspace_id or new.created_at<>old.created_at then
      raise exception 'record identity is immutable' using errcode='23514';
    end if;
    new.version := old.version+1;
  else new.version := 1; new.created_at := now(); end if;
  new.updated_at := now();
  if TG_TABLE_NAME='deals' then
    if new.stage in ('won','lost') then
      if TG_OP='INSERT' then new.closed_at:=now();
      elsif old.stage not in ('won','lost') then new.closed_at:=now();
      else new.closed_at:=old.closed_at; end if;
    else new.closed_at:=null; end if;
  end if;
  return new;
end $$;
create function product_record_audit() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into product_activity(workspace_id,entity_type,entity_id,actor_id,action,changes)
  values(new.workspace_id,TG_TABLE_NAME,new.id,auth.uid(),lower(TG_OP),
    case when TG_OP='INSERT' then jsonb_build_object('version',new.version)
    else (select coalesce(jsonb_object_agg(n.key,n.value),'{}'::jsonb) from jsonb_each(to_jsonb(new)) n where n.value is distinct from to_jsonb(old)->n.key and n.key not in ('updated_at','version')) end);
  return new;
end $$;
revoke all on function product_record_audit() from public;

do $$ declare t text; begin
  foreach t in array array['companies','customer_profiles','deals'] loop
    execute format('alter table %I enable row level security',t);
    execute format('create policy member_read on %I for select to authenticated using (is_workspace_member(workspace_id))',t);
    execute format('create policy member_create on %I for insert to authenticated with check (is_workspace_member(workspace_id))',t);
    execute format('create policy member_update on %I for update to authenticated using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id))',t);
    execute format('create trigger record_guard before insert or update on %I for each row execute function product_record_guard()',t);
    execute format('create trigger record_audit after insert or update on %I for each row execute function product_record_audit()',t);
  end loop;
end $$;
alter table customer_notes enable row level security;
create policy member_read on customer_notes for select to authenticated using(is_workspace_member(workspace_id));
create policy member_create on customer_notes for insert to authenticated with check(is_workspace_member(workspace_id) and author_id=auth.uid());
alter table product_activity enable row level security;
create policy member_read on product_activity for select to authenticated using(is_workspace_member(workspace_id));
-- Deliberately no client write policy for audit, and no hard deletes for CRM records.
commit;

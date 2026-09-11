begin;
create table editorial_drafts (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 200),body text not null default '' check(length(body)<=100000),
 campaign text not null default '' check(length(campaign)<=200),state text not null default 'draft' check(state in ('draft','in_review','approved')),
 scheduled_at timestamptz,timezone text not null default 'UTC' check(length(timezone)<=100),
 reviewed_by uuid references auth.users(id),reviewed_at timestamptz,
 version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id)
);
create table editorial_variants (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id) on delete cascade,
 draft_id uuid not null,channel_id uuid not null,body text not null check(length(body)<=100000),media_refs text[] not null default '{}' check(cardinality(media_refs)<=20),
 version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),unique(draft_id,channel_id),
 foreign key(workspace_id,draft_id) references editorial_drafts(workspace_id,id) on delete cascade
);
alter table channels add constraint channels_workspace_id_id_key unique(workspace_id,id);
alter table editorial_variants add foreign key(workspace_id,channel_id) references channels(workspace_id,id);
create table knowledge_sources (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 200),source_ref text not null check(length(trim(source_ref)) between 1 and 500),enabled boolean not null default false,
 version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),unique(workspace_id,source_ref)
);
create table mailbox_identities (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 200),address text not null check(address ~ '^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$' and length(address)<=254),
 gateway_account_ref text not null default '' check(length(gateway_account_ref)<=500),
 version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),unique(workspace_id,address)
);
create function editorial_guard() returns trigger language plpgsql set search_path=public as $$
begin
 if TG_OP='INSERT' then new.state:='draft';new.reviewed_by:=null;new.reviewed_at:=null;
 else
  if new.body<>old.body or new.name<>old.name or new.scheduled_at is distinct from old.scheduled_at or new.timezone<>old.timezone then new.state:='draft';end if;
  if new.state='approved' and old.state<>'approved' then
   if old.state<>'in_review' or not is_workspace_owner(new.workspace_id) then raise exception 'owner review required' using errcode='42501';end if;
   new.reviewed_by:=auth.uid();new.reviewed_at:=now();
  elsif new.state='approved' then new.reviewed_by:=old.reviewed_by;new.reviewed_at:=old.reviewed_at;
  else new.reviewed_by:=null;new.reviewed_at:=null;end if;
 end if;
 return new;
end $$;
create trigger editorial_guard before insert or update on editorial_drafts for each row execute function editorial_guard();
-- Changing a channel variant always invalidates a prior editorial approval.
create function editorial_variant_guard() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if TG_OP='UPDATE' and (new.draft_id<>old.draft_id or new.channel_id<>old.channel_id) then raise exception 'variant identity immutable' using errcode='23514';end if;
 update editorial_drafts set state='draft' where workspace_id=new.workspace_id and id=new.draft_id;
 return new;
end $$;
revoke all on function editorial_variant_guard() from public;
create trigger variant_guard after insert or update on editorial_variants for each row execute function editorial_variant_guard();
do $$ declare t text;begin
 foreach t in array array['editorial_drafts','editorial_variants','knowledge_sources','mailbox_identities'] loop
  execute format('alter table %I enable row level security',t);
  execute format('create policy member_read on %I for select to authenticated using(is_workspace_member(workspace_id))',t);
  if t in ('knowledge_sources','mailbox_identities') then
   execute format('create policy owner_create on %I for insert to authenticated with check(is_workspace_owner(workspace_id))',t);
   execute format('create policy owner_update on %I for update to authenticated using(is_workspace_owner(workspace_id)) with check(is_workspace_owner(workspace_id))',t);
  else
   execute format('create policy member_create on %I for insert to authenticated with check(is_workspace_member(workspace_id))',t);
   execute format('create policy member_update on %I for update to authenticated using(is_workspace_member(workspace_id)) with check(is_workspace_member(workspace_id))',t);
  end if;
  execute format('create trigger record_guard before insert or update on %I for each row execute function product_record_guard()',t);
  execute format('create trigger record_audit after insert or update on %I for each row execute function product_record_audit()',t);
 end loop;
end $$;
commit;

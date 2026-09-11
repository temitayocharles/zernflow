begin;
create table work_queues (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 200),description text not null default '' check(length(description)<=10000),
 version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,name)
);
create table work_items (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id) on delete cascade,
 reference bigint generated always as identity unique,
 name text not null check(length(trim(name)) between 1 and 200),description text not null default '' check(length(description)<=10000),
 kind text not null default 'ticket' check(kind in ('ticket','task','incident','follow_up')),
 status text not null default 'open' check(status in ('open','in_progress','waiting','resolved','closed')),
 priority text not null default 'normal' check(priority in ('low','normal','high','urgent')),
 queue_id uuid,assignee_id uuid,contact_id uuid,company_id uuid,conversation_id uuid,
 due_at timestamptz,
 first_response_minutes integer not null default 60 check(first_response_minutes between 1 and 525600),
 resolution_minutes integer not null default 1440 check(resolution_minutes between 1 and 525600),
 warning_fraction numeric not null default 0.8 check(warning_fraction>0 and warning_fraction<1),
 first_responded_at timestamptz,resolved_at timestamptz,
 escalated boolean not null default false,escalation_reason text not null default '' check(length(escalation_reason)<=2000),
 version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 foreign key(workspace_id,queue_id) references work_queues(workspace_id,id),
 foreign key(workspace_id,assignee_id) references workspace_members(workspace_id,user_id),
 foreign key(workspace_id,contact_id) references contacts(workspace_id,id),
 foreign key(workspace_id,company_id) references companies(workspace_id,id),
 foreign key(workspace_id,conversation_id) references conversations(workspace_id,id)
);
create index work_items_queue_idx on work_items(workspace_id,queue_id,status,priority);
create index work_items_assignee_idx on work_items(workspace_id,assignee_id,status);
create index work_items_contact_idx on work_items(workspace_id,contact_id);
create index work_items_conversation_idx on work_items(workspace_id,conversation_id);
create index work_items_backlog_idx on work_items(workspace_id,status,created_at);
alter table customer_notes add column work_item_id uuid;
alter table customer_notes drop constraint customer_notes_check;
alter table customer_notes add constraint customer_notes_target_check check(num_nonnulls(company_id,contact_id,deal_id,work_item_id)=1);
alter table customer_notes add foreign key(workspace_id,work_item_id) references work_items(workspace_id,id) on delete cascade;
create index customer_notes_work_item_idx on customer_notes(workspace_id,work_item_id,created_at desc);

create function work_item_guard() returns trigger language plpgsql set search_path=public as $$
begin
 if TG_OP='INSERT' then
   new.status:='open';new.first_responded_at:=null;new.resolved_at:=null;
 else
   if new.reference<>old.reference or new.first_response_minutes<>old.first_response_minutes or new.resolution_minutes<>old.resolution_minutes or new.warning_fraction<>old.warning_fraction then
     raise exception 'reference and SLA snapshot are immutable' using errcode='23514';
   end if;
   if new.status<>old.status and not (
      (old.status in ('open','in_progress','waiting') and new.status in ('open','in_progress','waiting','resolved')) or
      (old.status='resolved' and new.status in ('closed','open')) or (old.status='closed' and new.status='open')
   ) then raise exception 'invalid work item status transition' using errcode='23514'; end if;
   if old.first_responded_at is not null then new.first_responded_at:=old.first_responded_at;
   elsif new.first_responded_at is not null then new.first_responded_at:=now();end if;
   if new.status in ('resolved','closed') then new.resolved_at:=coalesce(old.resolved_at,now());else new.resolved_at:=null;end if;
 end if;
 if new.escalated and length(trim(new.escalation_reason))=0 then raise exception 'escalation reason required' using errcode='23514';end if;
 return new;
end $$;
create trigger work_guard before insert or update on work_items for each row execute function work_item_guard();
do $$ declare t text;begin
 foreach t in array array['work_queues','work_items'] loop
  execute format('alter table %I enable row level security',t);
  execute format('create policy member_read on %I for select to authenticated using(is_workspace_member(workspace_id))',t);
  execute format('create policy member_create on %I for insert to authenticated with check(is_workspace_member(workspace_id))',t);
  execute format('create policy member_update on %I for update to authenticated using(is_workspace_member(workspace_id)) with check(is_workspace_member(workspace_id))',t);
  execute format('create trigger record_guard before insert or update on %I for each row execute function product_record_guard()',t);
  execute format('create trigger record_audit after insert or update on %I for each row execute function product_record_audit()',t);
 end loop;
end $$;
grant usage,select on sequence work_items_reference_seq to authenticated;
commit;

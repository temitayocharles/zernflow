begin;
alter table customer_notes add column conversation_id uuid;
alter table customer_notes drop constraint customer_notes_target_check;
alter table customer_notes add constraint customer_notes_target_check check(num_nonnulls(company_id,contact_id,deal_id,work_item_id,conversation_id)=1);
alter table customer_notes add foreign key(workspace_id,conversation_id) references conversations(workspace_id,id) on delete cascade;
alter table customer_notes add column mention_ids uuid[] not null default '{}';
create index customer_notes_conversation_idx on customer_notes(workspace_id,conversation_id,created_at desc);
create table canned_replies (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 200),body text not null check(length(trim(body)) between 1 and 10000),
 version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,name)
);
alter table canned_replies enable row level security;
create policy member_read on canned_replies for select to authenticated using(is_workspace_member(workspace_id));
create policy member_create on canned_replies for insert to authenticated with check(is_workspace_member(workspace_id));
create policy member_update on canned_replies for update to authenticated using(is_workspace_member(workspace_id)) with check(is_workspace_member(workspace_id));
create trigger record_guard before insert or update on canned_replies for each row execute function product_record_guard();
create trigger record_audit after insert or update on canned_replies for each row execute function product_record_audit();
create table operator_notifications (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id) on delete cascade,
 recipient_id uuid not null,title text not null check(length(title)<=300),kind text not null,
 entity_type text not null check(entity_type in ('work_items','companies','contacts','deals','conversations')),
 entity_id uuid not null,dedupe_key text not null,created_at timestamptz not null default now(),read_at timestamptz,
 unique(workspace_id,recipient_id,dedupe_key),
 foreign key(workspace_id,recipient_id) references workspace_members(workspace_id,user_id) on delete cascade
);
create index notifications_recipient_idx on operator_notifications(workspace_id,recipient_id,read_at,created_at desc);
alter table operator_notifications enable row level security;
create policy recipient_read on operator_notifications for select to authenticated using(recipient_id=auth.uid() and is_workspace_member(workspace_id));
create policy recipient_update on operator_notifications for update to authenticated using(recipient_id=auth.uid() and is_workspace_member(workspace_id)) with check(recipient_id=auth.uid() and is_workspace_member(workspace_id));
create function notification_guard() returns trigger language plpgsql set search_path=public as $$
begin
 if (to_jsonb(new)-'read_at') is distinct from (to_jsonb(old)-'read_at') then raise exception 'only notification read state may change' using errcode='23514';end if;
 if new.read_at is not null then new.read_at:=coalesce(old.read_at,now());end if;
 return new;
end $$;
create trigger notification_guard before update on operator_notifications for each row execute function notification_guard();
create function work_item_notify() returns trigger language plpgsql security definer set search_path=public as $$
declare event_kind text;begin
 if new.assignee_id is null then return new;end if;
 if TG_OP='INSERT' then event_kind:='assignment';
 elsif new.assignee_id is distinct from old.assignee_id then event_kind:='assignment';
 elsif new.escalated and not old.escalated then event_kind:='escalation';
 elsif new.status<>old.status then event_kind:='ticket_update';else return new;end if;
 insert into operator_notifications(workspace_id,recipient_id,title,kind,entity_type,entity_id,dedupe_key)
 values(new.workspace_id,new.assignee_id,'ZF-'||new.reference||': '||event_kind,event_kind,'work_items',new.id,new.id||':'||new.version||':'||event_kind) on conflict do nothing;
 return new;
end $$;
revoke all on function work_item_notify() from public;
create trigger work_notify after insert or update on work_items for each row execute function work_item_notify();
create function note_mentions() returns trigger language plpgsql security definer set search_path=public as $$
declare recipient uuid;target uuid;kind text;begin
 if cardinality(new.mention_ids)>20 then raise exception 'maximum 20 mentions per note' using errcode='23514';end if;
 target:=coalesce(new.work_item_id,new.conversation_id,new.company_id,new.contact_id,new.deal_id);
 kind:=case when new.work_item_id is not null then 'work_items' when new.conversation_id is not null then 'conversations' when new.company_id is not null then 'companies' when new.contact_id is not null then 'contacts' else 'deals' end;
 foreach recipient in array new.mention_ids loop
  if not exists(select 1 from workspace_members where workspace_id=new.workspace_id and user_id=recipient) then raise exception 'mention must be a workspace member' using errcode='23514';end if;
  insert into operator_notifications(workspace_id,recipient_id,title,kind,entity_type,entity_id,dedupe_key)
  values(new.workspace_id,recipient,'You were mentioned in an internal note','mention',kind,target,'note:'||new.id) on conflict do nothing;
 end loop;
 return new;
end $$;
revoke all on function note_mentions() from public;
create trigger note_mentions after insert on customer_notes for each row execute function note_mentions();
create function internal_note_guard() returns trigger language plpgsql set search_path=public as $$
begin new.created_at:=now();return new;end $$;
create trigger internal_note_guard before insert on customer_notes for each row execute function internal_note_guard();
commit;

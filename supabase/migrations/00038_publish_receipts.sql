-- R10: provider-neutral publishing receipts.
--
-- One row per publication attempt of a scheduled channel variant, whatever the
-- route (api provider / Agent Social Gateway, managed browser, manual). The
-- receipt is the durable evidence of what ZernFlow asked a provider to do and
-- what the provider answered. It also drives idempotent polling: an attempt in
-- state `accepted` is polled by operation_ref instead of being resubmitted, and
-- an attempt left in `submitting`/`unknown` blocks automatic resubmission unless
-- the provider guarantees idempotent submits.
--
-- Forward-only; no historical migration is modified.

create table publish_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  variant_id uuid not null,
  task_id uuid,
  idempotency_key text not null check (length(idempotency_key) between 1 and 300),
  attempt integer not null check (attempt >= 1),
  mode text not null check (mode in ('api','browser','manual')),
  provider text not null check (length(provider) between 1 and 64),
  status text not null check (status in ('submitting','accepted','published','partial','failed','unknown')),
  operation_ref text check (operation_ref is null or length(operation_ref) <= 300),
  external_ref text check (external_ref is null or length(external_ref) <= 300),
  external_url text check (external_url is null or (length(external_url) <= 2000 and external_url ~ '^https://')),
  error_class text check (error_class is null or error_class in (
    'transient','rate_limited','auth_expired','reauth_required','human_challenge','unsupported_capability',
    'validation','policy_denied','unknown_outcome','internal')),
  error_code text check (error_code is null or length(error_code) <= 100),
  error_message text check (error_message is null or length(error_message) <= 1000),
  parts jsonb not null default '[]'::jsonb
    check (jsonb_typeof(parts) = 'array' and jsonb_array_length(parts) <= 50 and pg_column_size(parts) <= 16384),
  poll_count integer not null default 0 check (poll_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (workspace_id, idempotency_key, attempt),
  foreign key (workspace_id, variant_id) references editorial_variants(workspace_id, id) on delete cascade,
  foreign key (workspace_id, task_id) references tasks(workspace_id, id) on delete set null (task_id),
  constraint publish_receipts_accepted_has_ref check (status <> 'accepted' or operation_ref is not null)
);

create index publish_receipts_variant_idx on publish_receipts(workspace_id, variant_id, created_at desc);
create index publish_receipts_open_idx on publish_receipts(workspace_id, idempotency_key)
  where status in ('submitting','accepted','unknown');

create or replace function publish_receipt_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  allowed boolean;
begin
  if tg_op = 'INSERT' then
    if new.status in ('published','partial','failed') then
      new.settled_at := coalesce(new.settled_at, now());
    end if;
    return new;
  end if;
  if new.workspace_id <> old.workspace_id or new.variant_id <> old.variant_id
     or new.idempotency_key <> old.idempotency_key or new.attempt <> old.attempt
     or new.mode <> old.mode or new.provider <> old.provider or new.created_at <> old.created_at then
    raise exception 'publish receipt identity is immutable' using errcode = '42501';
  end if;
  if new.operation_ref is distinct from old.operation_ref and old.operation_ref is not null then
    raise exception 'publish receipt operation reference is immutable once set' using errcode = '42501';
  end if;
  if new.status <> old.status then
    allowed := case old.status
      when 'submitting' then new.status in ('accepted','published','partial','failed','unknown')
      when 'accepted'   then new.status in ('published','partial','failed','unknown')
      when 'unknown'    then new.status in ('accepted','published','partial','failed')
      else false  -- published, partial, failed are final
    end;
    if not allowed then
      raise exception 'illegal publish receipt transition % -> %', old.status, new.status using errcode = '23514';
    end if;
  elsif old.status in ('published','partial','failed') then
    raise exception 'settled publish receipts are immutable' using errcode = '23514';
  end if;
  if new.status in ('published','partial','failed') then
    new.settled_at := coalesce(new.settled_at, now());
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger publish_receipt_guard before insert or update on publish_receipts
  for each row execute function publish_receipt_guard();

alter table publish_receipts enable row level security;
revoke all on publish_receipts from anon, authenticated;
-- Members read their workspace's receipts; only the service role (engine, worker routes) writes.
grant select on publish_receipts to authenticated;
create policy member_read on publish_receipts for select to authenticated using (is_workspace_member(workspace_id));
revoke all on function publish_receipt_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Manual confirmation also records a receipt (redefinition; same signature,
-- same checks and side effects as 00033 plus the receipt insert).
-- ---------------------------------------------------------------------------
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
  if v.idempotency_key is not null then
    insert into publish_receipts (workspace_id, variant_id, task_id, idempotency_key, attempt, mode, provider, status,
                                  external_ref, external_url)
    values (v.workspace_id, v.id, v.task_id, v.idempotency_key,
            coalesce((select max(r.attempt) from publish_receipts r
                       where r.workspace_id = v.workspace_id and r.idempotency_key = v.idempotency_key), 0) + 1,
            'manual', 'operator', 'published', left(p_external_ref, 300), p_external_url);
  end if;
  insert into product_activity(workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (v.workspace_id, 'editorial_variants', v.id, auth.uid(), 'content.published_manually', jsonb_build_object('url', p_external_url));
  return 'published';
end $$;

revoke all on function confirm_manual_publication(uuid, text, text) from public, anon;
grant execute on function confirm_manual_publication(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Operator reconciliation of an ambiguous API/browser attempt.
--   p_outcome = 'published'     → operator saw the post live (https link required).
--   p_outcome = 'not_published' → operator checked and nothing is live; the job is
--                                  re-queued and resubmits with the same idempotency key.
-- Only valid while the variant is failed and its latest receipt is unknown
-- (or partial, for 'published' only: a partial post cannot be "not published").
-- ---------------------------------------------------------------------------
create or replace function resolve_publication(p_variant uuid, p_outcome text, p_external_url text default null, p_external_ref text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  v editorial_variants;
  t tasks;
  r publish_receipts;
  v_owner text := 'human:' || coalesce(auth.uid()::text, 'unknown');
begin
  if p_outcome not in ('published','not_published') then
    raise exception 'outcome must be published or not_published' using errcode = '22023';
  end if;
  select * into v from editorial_variants where id = p_variant for update;
  if not found or not is_workspace_member(v.workspace_id) then
    raise exception 'variant unavailable' using errcode = '42501';
  end if;
  if v.execution_mode not in ('api','browser') or v.publish_state <> 'failed' or v.idempotency_key is null then
    raise exception 'only failed api/browser publications can be reconciled' using errcode = '23514';
  end if;
  select * into r from publish_receipts
   where workspace_id = v.workspace_id and idempotency_key = v.idempotency_key
   order by attempt desc limit 1 for update;
  if not found or r.status not in ('unknown','partial') then
    raise exception 'the latest attempt is not ambiguous; nothing to reconcile' using errcode = '23514';
  end if;
  if v.task_id is not null then
    select * into t from tasks where id = v.task_id for update;
  end if;

  if p_outcome = 'not_published' then
    if r.status = 'partial' then
      raise exception 'a partially published post cannot be marked not published' using errcode = '23514';
    end if;
    update publish_receipts set status = 'failed', error_message = 'Operator confirmed the post is not live.'
     where id = r.id;
    if t.id is not null and t.state = 'waiting_for_user' then
      update tasks set state = 'queued', human_intervention = 'resolved', next_run_at = now() where id = t.id;
      update editorial_variants set publish_state = 'scheduled', last_error = null where id = v.id;
      perform task_log(v.workspace_id, t.id, 'info', 'Operator confirmed not published; resubmitting', '{}'::jsonb);
    end if;
    insert into product_activity(workspace_id, entity_type, entity_id, actor_id, action, changes)
    values (v.workspace_id, 'editorial_variants', v.id, auth.uid(), 'content.reconciled_not_published', '{}'::jsonb);
    return 'not_published';
  end if;

  if p_external_url is null or p_external_url !~ '^https://' or length(p_external_url) > 2000 then
    raise exception 'a https link to the published post is required' using errcode = '22023';
  end if;
  if t.id is not null and t.state in ('queued','waiting_for_user') then
    if t.state = 'waiting_for_user' then
      update tasks set state = 'queued' where id = t.id;
    end if;
    update tasks set state = 'running', attempts = attempts + 1, lease_owner = v_owner,
                     lease_expires_at = now() + interval '1 minute', started_at = coalesce(started_at, now())
     where id = t.id;
    update tasks set state = 'completed',
                     result = jsonb_build_object('externalUrl', p_external_url, 'reconciledBy', auth.uid()),
                     human_intervention = case when human_intervention = 'none' then 'none' else 'resolved' end
     where id = t.id;
    perform task_log(v.workspace_id, t.id, 'info', 'Publication reconciled by operator', jsonb_build_object('url', p_external_url));
  end if;
  update editorial_variants set publish_state = 'scheduled' where id = v.id;
  update editorial_variants set publish_state = 'publishing' where id = v.id;
  update editorial_variants
     set publish_state = 'published', external_url = p_external_url,
         external_ref = coalesce(left(p_external_ref, 300), r.external_ref), published_at = now(), last_error = null
   where id = v.id;
  insert into publish_receipts (workspace_id, variant_id, task_id, idempotency_key, attempt, mode, provider, status,
                                external_ref, external_url)
  values (v.workspace_id, v.id, v.task_id, v.idempotency_key, r.attempt + 1, 'manual', 'operator', 'published',
          coalesce(left(p_external_ref, 300), r.external_ref), p_external_url);
  insert into product_activity(workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (v.workspace_id, 'editorial_variants', v.id, auth.uid(), 'content.reconciled_published', jsonb_build_object('url', p_external_url));
  return 'published';
end $$;

revoke all on function resolve_publication(uuid, text, text, text) from public, anon;
grant execute on function resolve_publication(uuid, text, text, text) to authenticated, service_role;

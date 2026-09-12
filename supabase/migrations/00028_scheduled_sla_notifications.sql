begin;
-- Reuse the existing authenticated cron entrypoint. No new scheduler or event ledger.
create function refresh_sla_notifications(p_as_of timestamptz default now()) returns integer
language plpgsql security definer set search_path=public as $$
declare inserted integer;begin
 if not pg_try_advisory_xact_lock(hashtext('zernflow.sla_notification_scan')) then return 0;end if;
 with candidates as (
  select w.workspace_id,w.assignee_id as recipient_id,w.id as entity_id,
    'ZF-'||w.reference||': '||objective.label||' SLA '||signal.state as title,
    'sla_'||signal.state as kind,
    'sla:'||w.id||':'||objective.key||':'||signal.state as dedupe_key,w.created_at
  from work_items w
  cross join lateral(values('firstResponse','First response',w.first_response_minutes,w.first_responded_at),('resolution','Resolution',w.resolution_minutes,w.resolved_at)) as objective(key,label,minutes,completed_at)
  cross join lateral(select case when p_as_of>=w.created_at+objective.minutes*interval '1 minute' then 'breached' else 'warning' end as state) signal
  where w.status not in ('resolved','closed') and w.assignee_id is not null and objective.completed_at is null
    and p_as_of>=w.created_at+objective.minutes*w.warning_fraction*interval '1 minute'
 ), pending as (
  select c.* from candidates c where not exists(select 1 from operator_notifications n where n.workspace_id=c.workspace_id and n.recipient_id=c.recipient_id and n.dedupe_key=c.dedupe_key)
  order by c.created_at,c.entity_id,c.dedupe_key limit 1000
 )
 insert into operator_notifications(workspace_id,recipient_id,title,kind,entity_type,entity_id,dedupe_key)
 select workspace_id,recipient_id,title,kind,'work_items',entity_id,dedupe_key from pending on conflict do nothing;
 get diagnostics inserted=row_count;
 return inserted;
end $$;
revoke all on function refresh_sla_notifications(timestamptz) from public;
grant execute on function refresh_sla_notifications(timestamptz) to service_role;
commit;

begin;
-- Aggregate in PostgreSQL so dashboard totals are not silently capped at an API page.
create function operator_metrics(p_workspace_id uuid) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;begin
 if not is_workspace_member(p_workspace_id) then raise exception 'workspace membership required' using errcode='42501';end if;
 select jsonb_build_object(
  'work_items',jsonb_build_object(
   'total',count(*),'backlog',count(*) filter(where status not in ('resolved','closed')),
   'unassigned',count(*) filter(where assignee_id is null and status not in ('resolved','closed')),
   'escalated',count(*) filter(where escalated and status not in ('resolved','closed')),
   'resolution_breached',count(*) filter(where resolved_at is null and status not in ('resolved','closed') and now()>=created_at+resolution_minutes*interval '1 minute'),
   'resolution_warning',count(*) filter(where resolved_at is null and status not in ('resolved','closed') and now()>=created_at+resolution_minutes*warning_fraction*interval '1 minute' and now()<created_at+resolution_minutes*interval '1 minute'),
   'first_response_breached',count(*) filter(where first_responded_at is null and status not in ('resolved','closed') and now()>=created_at+first_response_minutes*interval '1 minute'),
   'response_samples',count(first_responded_at),'resolution_samples',count(resolved_at),
   'average_response_seconds',avg(extract(epoch from first_responded_at-created_at)),
   'average_resolution_seconds',avg(extract(epoch from resolved_at-created_at))
  ),
  'contacts',(select jsonb_build_object('total',count(*),'created_last_30_days',count(*) filter(where created_at>=now()-interval '30 days')) from contacts where workspace_id=p_workspace_id),
  'companies',(select count(*) from companies where workspace_id=p_workspace_id),
  'pipeline_by_currency',(select coalesce(jsonb_agg(v),'[]'::jsonb) from (select currency,count(*) as deals,sum(value_minor)::text as value_minor from deals where workspace_id=p_workspace_id and stage not in ('won','lost') group by currency order by currency) v),
  'conversation_projection',(select jsonb_build_object('total',count(*),'open',count(*) filter(where status='open'),'snoozed',count(*) filter(where status='snoozed'),'automation_paused',count(*) filter(where is_automation_paused)) from conversations where workspace_id=p_workspace_id),
  'flows',(select jsonb_build_object('total',count(*),'published',count(*) filter(where status='published')) from flows where workspace_id=p_workspace_id),
  'sequences',(select jsonb_build_object('total',count(*),'active',count(*) filter(where status='active')) from sequences where workspace_id=p_workspace_id),
  'channels',(select jsonb_build_object('projected',count(*),'active_projection',count(*) filter(where is_active)) from channels where workspace_id=p_workspace_id),
  'as_of',now()
 ) into result from work_items where workspace_id=p_workspace_id;
 return result;
end $$;
revoke all on function operator_metrics(uuid) from public;
grant execute on function operator_metrics(uuid) to authenticated;
commit;

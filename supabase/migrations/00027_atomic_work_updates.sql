begin;
create function bulk_update_work_items(p_workspace_id uuid,p_changes jsonb) returns integer language plpgsql set search_path=public as $$
declare change jsonb;updated integer;total integer:=0;begin
 if not is_workspace_member(p_workspace_id) then raise exception 'workspace membership required' using errcode='42501';end if;
 if jsonb_typeof(p_changes)<>'array' or jsonb_array_length(p_changes) not between 1 and 50 then raise exception 'one to fifty changes required' using errcode='23514';end if;
 -- Stable lock order avoids competing bulk requests locking rows in reverse order.
 for change in select value from jsonb_array_elements(p_changes) order by value->>'id' loop
  if jsonb_typeof(change)<>'object' or not(change?'id' and change?'version') or not(change?'status' or change?'priority') then raise exception 'invalid bulk change' using errcode='23514';end if;
  if exists(select 1 from jsonb_object_keys(change) k where k not in ('id','version','status','priority')) then raise exception 'unsupported bulk field' using errcode='23514';end if;
  update work_items set status=coalesce(change->>'status',status),priority=coalesce(change->>'priority',priority)
   where workspace_id=p_workspace_id and id=(change->>'id')::uuid and version=(change->>'version')::integer;
  get diagnostics updated=row_count;
  if updated<>1 then raise exception 'work item changed or unavailable' using errcode='P0002';end if;
  total:=total+updated;
 end loop;
 return total;
end $$;
revoke all on function bulk_update_work_items(uuid,jsonb) from public;
grant execute on function bulk_update_work_items(uuid,jsonb) to authenticated;
commit;

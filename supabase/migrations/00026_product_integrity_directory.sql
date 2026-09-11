begin;
create function customer_profile_identity_guard() returns trigger language plpgsql set search_path=public as $$
begin if new.contact_id<>old.contact_id then raise exception 'customer profile contact identity is immutable' using errcode='23514';end if;return new;end $$;
create trigger profile_identity_guard before update on customer_profiles for each row execute function customer_profile_identity_guard();
-- Member names are available only inside the explicitly authorized workspace.
-- No email, credentials, or unrelated Auth metadata is returned.
create function workspace_operator_directory(p_workspace_id uuid) returns table(user_id uuid,display_name text,role text)
language plpgsql stable security definer set search_path=public as $$
begin
 if not is_workspace_member(p_workspace_id) then raise exception 'workspace membership required' using errcode='42501';end if;
 return query select wm.user_id,left(coalesce(nullif(u.raw_user_meta_data->>'full_name',''),nullif(u.raw_user_meta_data->>'name',''),'Workspace member'),200),wm.role
 from workspace_members wm join auth.users u on u.id=wm.user_id where wm.workspace_id=p_workspace_id order by wm.created_at,wm.user_id limit 500;
end $$;
revoke all on function workspace_operator_directory(uuid) from public;
grant execute on function workspace_operator_directory(uuid) to authenticated;
-- Preserve work/customer entities when a team member leaves; clear only the
-- member reference, never the workspace half of a composite foreign key.
alter table companies drop constraint companies_workspace_id_owner_id_fkey;
alter table companies add foreign key(workspace_id,owner_id) references workspace_members(workspace_id,user_id) on delete set null(owner_id);
alter table customer_profiles drop constraint customer_profiles_workspace_id_owner_id_fkey;
alter table customer_profiles add foreign key(workspace_id,owner_id) references workspace_members(workspace_id,user_id) on delete set null(owner_id);
alter table deals drop constraint deals_workspace_id_owner_id_fkey;
alter table deals add foreign key(workspace_id,owner_id) references workspace_members(workspace_id,user_id) on delete set null(owner_id);
alter table work_items drop constraint work_items_workspace_id_assignee_id_fkey;
alter table work_items add foreign key(workspace_id,assignee_id) references workspace_members(workspace_id,user_id) on delete set null(assignee_id);
commit;

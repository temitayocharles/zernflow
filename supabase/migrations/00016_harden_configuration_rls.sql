-- Restrict configuration changes that can affect provider credentials, webhook
-- routing or workspace-wide automation. Runtime credentials are moving to the
-- server-only Agent Social Gateway boundary; legacy columns remain temporarily
-- for migration compatibility and must not be writable by ordinary members.

create or replace function is_workspace_owner(ws_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from workspace_members
    where workspace_id = ws_id
      and user_id = auth.uid()
      and role = 'owner'
  );
$$;

revoke all on function is_workspace_owner(uuid) from public;
grant execute on function is_workspace_owner(uuid) to authenticated;

drop policy if exists "Users can update their workspaces" on workspaces;
drop policy if exists "Owners can update their workspaces" on workspaces;

create policy "Owners can update their workspaces"
  on workspaces for update
  using (is_workspace_owner(id))
  with check (is_workspace_owner(id));

drop policy if exists "Users can manage channels in their workspaces" on channels;
drop policy if exists "Owners can insert channels" on channels;
drop policy if exists "Owners can update channels" on channels;
drop policy if exists "Owners can delete channels" on channels;

create policy "Owners can insert channels"
  on channels for insert
  with check (is_workspace_owner(workspace_id));

create policy "Owners can update channels"
  on channels for update
  using (is_workspace_owner(workspace_id))
  with check (is_workspace_owner(workspace_id));

create policy "Owners can delete channels"
  on channels for delete
  using (is_workspace_owner(workspace_id));

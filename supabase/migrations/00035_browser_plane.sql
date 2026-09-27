-- R6: browser plane.
-- * Sessions gain an 'unverified' state (storage state imported, not yet checked)
--   and an explicit per-session opt-in for experimental adapter capabilities.
-- * Workers report the adapter capabilities and version they run (display only;
--   authority stays with the control plane).
-- All browser_sessions writes remain server-side (service role); members read.

alter table browser_sessions drop constraint if exists browser_sessions_status_check;
alter table browser_sessions add constraint browser_sessions_status_check check (status in (
  'unverified','human_login_required','mfa_required','challenge_required','healthy','degraded','expired','revoked'));

alter table browser_sessions
  add column allow_experimental boolean not null default false,
  add column last_check_task_id uuid;

-- A session can only be used once its owner has attested permitted use.
alter table browser_sessions add constraint browser_sessions_experimental_needs_attestation
  check (not allow_experimental or permitted_use_confirmed);

create or replace function browser_session_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.id <> old.id or new.workspace_id <> old.workspace_id or new.profile_key <> old.profile_key
     or new.created_at <> old.created_at or new.platform <> old.platform then
    raise exception 'browser session identity is immutable' using errcode = '23514';
  end if;
  if old.status = 'revoked' and new.status <> 'revoked' then
    raise exception 'revoked browser sessions cannot be reactivated' using errcode = '23514';
  end if;
  if old.status = 'revoked' and new.storage_state_secret_id is not null
     and new.storage_state_secret_id is distinct from old.storage_state_secret_id then
    raise exception 'revoked browser sessions cannot receive a new session state' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;

alter table worker_identities
  add column capabilities jsonb not null default '{}'::jsonb
    check (jsonb_typeof(capabilities) = 'object' and pg_column_size(capabilities) <= 8192),
  add column version text check (version is null or length(version) <= 64);

-- Keep the column-level grant list (00031) in sync: members may read the new display columns.
grant select (capabilities, version) on worker_identities to authenticated;

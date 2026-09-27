-- 00032: Envelope-encrypted secret store, artifact metadata, browser sessions.
-- See docs/architecture/SECRET_STORE_DESIGN.md, ARTIFACT_STORAGE_DESIGN.md,
-- BROWSER_AUTOMATION_DESIGN.md.
--
-- Browser roles read metadata only. Ciphertext (secret_versions) has no
-- client grants and no policies. All writes are server-side after owner
-- checks (service role), and every secret access is audited.

-- ---------------------------------------------------------------------------
-- Secrets
-- ---------------------------------------------------------------------------
create table secrets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  kind text not null check (kind in (
    'ai_provider_key','webhook_signing','browser_credential','browser_session_state',
    'provider_app_credential','api_token','other')),
  provider text check (provider is null or length(provider) <= 64),
  description text not null default '' check (length(description) <= 1000),
  binding text check (binding is null or binding ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  status text not null default 'active' check (status in ('active','revoked','deleted')),
  current_version integer not null default 1 check (current_version >= 1),
  expires_at timestamptz,
  last_used_at timestamptz,
  last_used_by text check (last_used_by is null or length(last_used_by) <= 200),
  rotated_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  deleted_at timestamptz,
  unique (workspace_id, id)
);
create unique index secrets_live_name_idx on secrets(workspace_id, lower(name)) where status <> 'deleted';
create unique index secrets_binding_idx on secrets(workspace_id, binding) where binding is not null and status = 'active';

create table secret_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  secret_id uuid not null,
  version integer not null check (version >= 1),
  algorithm text not null default 'AES-256-GCM' check (algorithm = 'AES-256-GCM'),
  ciphertext text not null check (length(ciphertext) between 1 and 200000),
  iv text not null check (length(iv) between 8 and 64),
  auth_tag text not null check (length(auth_tag) between 8 and 64),
  wrapped_dek text not null check (length(wrapped_dek) between 8 and 4096),
  kek_provider text not null check (kek_provider in ('local','vault-transit')),
  kek_key_id text not null check (length(kek_key_id) between 1 and 200),
  kek_version integer,
  created_by text check (created_by is null or length(created_by) <= 200),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (secret_id, version),
  foreign key (workspace_id, secret_id) references secrets(workspace_id, id) on delete cascade
);

create table secret_access_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  secret_id uuid,
  action text not null check (action in ('create','rotate','revoke','delete','resolve','resolve_denied','import')),
  actor_type text not null check (actor_type in ('user','service','worker')),
  actor_id text check (actor_id is null or length(actor_id) <= 200),
  purpose text check (purpose is null or length(purpose) <= 200),
  outcome text not null default 'success' check (outcome in ('success','denied','error')),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 4096),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, secret_id) references secrets(workspace_id, id) on delete set null (secret_id)
);
create index secret_access_events_idx on secret_access_events(workspace_id, created_at desc);

create or replace function secret_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.id <> old.id or new.workspace_id <> old.workspace_id or new.created_at <> old.created_at then
    raise exception 'secret identity is immutable' using errcode = '23514';
  end if;
  if old.status = 'deleted' and new.status <> 'deleted' then
    raise exception 'deleted secrets cannot be restored' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger secret_guard before update on secrets for each row execute function secret_guard();

-- ---------------------------------------------------------------------------
-- Artifacts (object bytes live in S3-compatible storage; metadata here)
-- ---------------------------------------------------------------------------
create table artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('image','video','document','screenshot','trace','export','import','bundle','report','backup','other')),
  object_key text not null unique check (length(object_key) <= 400),
  file_name text not null default '' check (length(file_name) <= 255),
  content_type text not null check (length(content_type) between 3 and 100),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_upload' check (status in ('pending_upload','available','quarantined','deleted')),
  retention_until timestamptz,
  campaign_id uuid,
  task_id uuid,
  execution_record_id uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 8192),
  created_by uuid references auth.users(id) on delete set null,
  created_by_worker uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  unique (workspace_id, id),
  check (object_key like 'ws/' || workspace_id::text || '/%'),
  foreign key (workspace_id, task_id) references tasks(workspace_id, id) on delete set null (task_id),
  foreign key (workspace_id, created_by_worker) references worker_identities(workspace_id, id) on delete set null (created_by_worker)
);
create index artifacts_workspace_idx on artifacts(workspace_id, created_at desc) where status <> 'deleted';
create index artifacts_retention_idx on artifacts(retention_until) where status <> 'deleted' and retention_until is not null;
create index artifacts_pending_idx on artifacts(created_at) where status = 'pending_upload';

create or replace function artifact_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.id <> old.id or new.workspace_id <> old.workspace_id or new.object_key <> old.object_key
     or new.created_at <> old.created_at or new.sha256 <> old.sha256 then
    raise exception 'artifact identity is immutable' using errcode = '23514';
  end if;
  if old.status = 'deleted' and new.status <> 'deleted' then
    raise exception 'deleted artifacts cannot be restored' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger artifact_guard before update on artifacts for each row execute function artifact_guard();

-- ---------------------------------------------------------------------------
-- Browser sessions (managed Playwright profiles; secrets hold session state)
-- ---------------------------------------------------------------------------
create table browser_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  platform text not null check (platform ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text not null check (length(trim(label)) between 1 and 200),
  account_hint text check (account_hint is null or length(account_hint) <= 200),
  status text not null default 'human_login_required' check (status in (
    'human_login_required','mfa_required','challenge_required','healthy','degraded','expired','revoked')),
  storage_state_secret_id uuid,
  credential_secret_id uuid,
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  permitted_use_confirmed boolean not null default false,
  permitted_use_confirmed_by uuid references auth.users(id) on delete set null,
  permitted_use_confirmed_at timestamptz,
  profile_key uuid not null default gen_random_uuid() unique,
  expires_at timestamptz,
  last_verified_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, storage_state_secret_id) references secrets(workspace_id, id) on delete set null (storage_state_secret_id),
  foreign key (workspace_id, credential_secret_id) references secrets(workspace_id, id) on delete set null (credential_secret_id),
  check (not permitted_use_confirmed or permitted_use_confirmed_by is not null or permitted_use_confirmed_at is not null)
);
create index browser_sessions_workspace_idx on browser_sessions(workspace_id, platform);

create or replace function browser_session_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.id <> old.id or new.workspace_id <> old.workspace_id or new.profile_key <> old.profile_key
     or new.created_at <> old.created_at then
    raise exception 'browser session identity is immutable' using errcode = '23514';
  end if;
  if old.status = 'revoked' and new.status <> 'revoked' then
    raise exception 'revoked browser sessions cannot be reactivated' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger browser_session_guard before update on browser_sessions
  for each row execute function browser_session_guard();

-- ---------------------------------------------------------------------------
-- Operator notifications may reference the new platform entities.
-- ---------------------------------------------------------------------------
alter table operator_notifications drop constraint if exists operator_notifications_entity_type_check;
alter table operator_notifications add constraint operator_notifications_entity_type_check check (entity_type in (
  'work_items','companies','contacts','deals','conversations',
  'secrets','tasks','browser_sessions','campaigns','artifacts'));

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter table secrets enable row level security;
alter table secret_versions enable row level security;
alter table secret_access_events enable row level security;
alter table artifacts enable row level security;
alter table browser_sessions enable row level security;

revoke all on secrets, secret_versions, secret_access_events, artifacts, browser_sessions from anon, authenticated;
grant select on secrets, secret_access_events, artifacts, browser_sessions to authenticated;

create policy member_read on secrets for select to authenticated using (is_workspace_member(workspace_id));
create policy member_read on secret_access_events for select to authenticated using (is_workspace_member(workspace_id));
create policy member_read on artifacts for select to authenticated using (is_workspace_member(workspace_id));
create policy member_read on browser_sessions for select to authenticated using (is_workspace_member(workspace_id));
-- secret_versions: RLS on, no policies, no grants → service role only.

revoke all on function secret_guard(), artifact_guard(), browser_session_guard() from public, anon, authenticated;

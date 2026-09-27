-- 00039: manual channels for newer platforms, KEK rewrap audit action, audit cursor indexes,
-- recurring content source columns.
-- Forward-only; no historical migration is modified.

-- ---------------------------------------------------------------------------
-- 1. channels.platform: threads / linkedin / tiktok / youtube (R4 deferred item).
--    The Gateway account model does not include these platforms, so they are
--    allowed ONLY for operator-registered manual channels (late_account_id
--    'manual:<platform>:<handle>'), used for manual or browser publishing.
--    This keeps ZernFlow from ever implying a provider integration it lacks.
-- ---------------------------------------------------------------------------
alter table channels drop constraint if exists channels_platform_check;
alter table channels add constraint channels_platform_check check (platform in (
  'facebook','instagram','twitter','telegram','bluesky','reddit',
  'threads','linkedin','tiktok','youtube'));
alter table channels add constraint channels_manual_only_platforms check (
  platform not in ('threads','linkedin','tiktok','youtube') or late_account_id like 'manual:%');
alter table channels add constraint channels_manual_ref_format check (
  late_account_id not like 'manual:%'
  or late_account_id ~ ('^manual:' || platform || ':[a-z0-9._-]{1,100}$'));

-- ---------------------------------------------------------------------------
-- 2. KEK rotation audit action.
-- ---------------------------------------------------------------------------
alter table secret_access_events drop constraint if exists secret_access_events_action_check;
alter table secret_access_events add constraint secret_access_events_action_check check (action in (
  'create','rotate','revoke','delete','resolve','resolve_denied','import','rewrap'));

-- ---------------------------------------------------------------------------
-- 3. Audit log keyset pagination on (created_at, id) (R7 deferred item).
-- ---------------------------------------------------------------------------
create index if not exists product_activity_ws_created_id_idx on product_activity(workspace_id, created_at desc, id desc);
create index if not exists secret_access_events_ws_created_id_idx on secret_access_events(workspace_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- 4. Recurring content (R4 deferred item): a `content.recur` task schedule
--    materialises a fresh draft copy of a content item per occurrence. The copy
--    records its source; `source_task_id` is unique so a retried occurrence
--    never creates a second copy. Copies always start as `draft` (human review
--    and scheduling stay explicit).
-- ---------------------------------------------------------------------------
alter table editorial_drafts
  add column source_draft_id uuid,
  add column source_task_id uuid,
  add constraint editorial_drafts_source_fk
    foreign key (workspace_id, source_draft_id) references editorial_drafts(workspace_id, id) on delete set null (source_draft_id),
  add constraint editorial_drafts_source_task_key unique (source_task_id);
create index editorial_drafts_source_idx on editorial_drafts(workspace_id, source_draft_id) where source_draft_id is not null;

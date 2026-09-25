# Domain Model

All workspace-owned tables carry `workspace_id`, use composite `(workspace_id, id)` uniqueness and composite
foreign keys so a row can never reference another tenant's row, even with direct PostgREST writes.

## Campaign (`campaigns`) — new (00033)

| Field | Notes |
| --- | --- |
| `name`, `objective` | objective ∈ awareness, engagement, lead_generation, sales, launch, community, other |
| `status` | draft → planned → active ⇄ paused → completed / archived |
| `owner_id` | workspace member (composite FK, set null on departure) |
| `audience` | jsonb description (segments, personas); segment ids are validated in app |
| `channel_ids` | uuid[]; validated by trigger against workspace channels |
| `voice` | messaging/voice guide text |
| `content_plan` | jsonb (pillars, cadence) |
| `utm_defaults` | jsonb `{source, medium, campaign, term, content}` |
| `starts_at`, `ends_at`, `timezone` | |
| `requires_approval` | if true, content in this campaign must be owner-approved before scheduling |
| `results` | jsonb summary written by workers/analytics (never trusted from browser) |
| `notes` | free text; detailed notes use `customer_notes`-style activity |

Links: content items (`editorial_drafts.campaign_id`), tasks (`tasks.campaign_id`), schedules, artifacts,
flows/triggers (future: `flows.campaign_id`), contacts via lead source (`customer_profiles.source` + UTM).

## Content item (`editorial_drafts`, extended) and Channel variant (`editorial_variants`, extended)

Consolidated rather than duplicated. New columns (00033):

* content item: `campaign_id`, `kind` (post, short_video, story, thread, article, reel, carousel),
  `link_url`, `utm` jsonb, `asset_ids` uuid[] (artifacts), existing `state` (draft/in_review/approved).
* variant: `publish_state` (see below), `scheduled_at` (per-channel override), `idempotency_key`,
  `external_ref`, `external_url`, `published_at`, `last_error`, `attempt_count`, `execution_mode`
  (api/browser/manual), `task_id`.

### Publish state machine (per variant)

```
draft ─schedule→ scheduled ─due→ queued ─claim→ publishing ─ok→ published
  ▲                 │                │              └─fail→ failed ─retry→ queued
  └──unschedule─────┘                └─cancel→ cancelled        └─cancel→ cancelled
```

Aggregate content state (`content_publish_summary()`): all published → `published`; some published and some
failed/cancelled → `partially_published`; any publishing → `publishing`; any queued → `queued`; any scheduled
→ `scheduled`; all failed → `failed`; all cancelled → `cancelled`; else `draft`.

Editing content/variants after scheduling is rejected unless the variant is unscheduled first (prevents
publishing unapproved text). Approval invalidation (existing guard) is retained.

## Task (`tasks`) — new (00031)

`objective`, `kind`, `workspace_id`, `campaign_id?`, `state`, `current_step`, `depends_on` uuid[],
`execution_mode` (internal, api, browser, human), `retry_policy` jsonb `{maxAttempts, baseDelayMs,
maxDelayMs}`, `attempts`, `next_run_at`, `lease_owner`, `lease_expires_at`, `idempotency_key` (unique per
workspace), `input` jsonb, `result` jsonb, `error` jsonb `{class, message, retryable}`,
`requires_approval`, `approval_state` (not_required, pending, approved, rejected), `approved_by/at`,
`human_intervention` (none, requested, in_progress, resolved) + `intervention_reason`, `schedule_id?`,
`correlation_id`, `subject_type/subject_id` (e.g. `editorial_variants`, `browser_sessions`).

States: `queued, running, waiting, waiting_for_user, retrying, completed, failed, cancelled` (+ `dead_lettered`
flag via `dead_lettered_at`). Transitions enforced by a DB trigger — see `EXECUTION_MODEL.md`.

`task_events` — append-only log (level, message, data), no secrets. `task_schedules` — recurring definitions
(`cron` expression subset or `interval_seconds`, timezone, template kind/input, `next_run_at`, enabled).

## Execution record (`execution_records`) — new (00031)

One row per external attempt: `correlation_id`, `workspace_id`, `task_id`, `provider`, `account_ref`,
`operation`, `mode` (api/browser), `attempt`, `status` (started, succeeded, failed, unknown), `started_at`,
`finished_at`, `latency_ms`, `result_meta` jsonb (redacted), `error_class` (see taxonomy), `error_message`
(redacted), `retry_decision` (retry, give_up, needs_user, none), `artifact_ids` uuid[], `external_ref`.

## Secrets (00032)

`secrets` (metadata: name, kind, provider, scope, owner workspace, status active/revoked/deleted,
`current_version`, `expires_at`, `last_used_at`, `last_used_by`, `rotated_at`), `secret_versions`
(ciphertext, iv, auth tag, wrapped DEK, KEK id/version, algorithm, created_by; never selectable by clients),
`secret_access_events` (audit: action, actor/service identity, purpose, outcome). See `SECRET_STORE_DESIGN.md`.

## Browser session (`browser_sessions`) — new (00032)

`platform`, `label`, `account_hint` (non-secret handle), `status` (human_login_required, mfa_required,
challenge_required, healthy, degraded, expired, revoked), `storage_state_secret_id` (encrypted cookies/local
storage in the secret store), `credential_secret_id?`, `capabilities` jsonb, `permitted_use_confirmed`
(owner attestation), `expires_at`, `last_verified_at`, `last_error`, `profile_key` (isolated profile id).

## Artifact (`artifacts`) — new (00032)

`kind` (image, video, document, screenshot, trace, export, import, bundle, report, backup, other),
`object_key` (`ws/<workspace_id>/<kind>/<yyyy>/<mm>/<uuid>`), `content_type`, `size_bytes`, `sha256`,
`status` (pending_upload, available, quarantined, deleted), `retention_until`, `campaign_id?`, `task_id?`,
`execution_record_id?`, `created_by`, `metadata` jsonb.

## Existing entities retained

Contacts/identities (`contacts`, `contact_channels`), CRM (`companies`, `customer_profiles`, `deals`,
`customer_notes`, `product_activity`), service desk (`work_items`, `work_queues`), automation (`flows`,
`triggers`, `flow_sessions`, `sequences`, `broadcasts`), inbox (`conversations`, `messages`).
Lead attribution: `customer_profiles.source` + UTM captured from campaign links (future column
`customer_profiles.campaign_id`, roadmap R4).

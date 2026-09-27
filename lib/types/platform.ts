import type { Json } from "@/lib/types/database";

/**
 * Hand-maintained row types for the social-OS platform tables (migrations
 * 00031+). Regenerate with `supabase gen types` once a live schema is
 * available (tracked in docs/EXECUTION_LEDGER.md).
 */

export const TASK_STATES = [
  "queued",
  "running",
  "waiting",
  "waiting_for_user",
  "retrying",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type ExecutionMode = "internal" | "api" | "browser" | "human";
export type ApprovalState = "not_required" | "pending" | "approved" | "rejected";
export type ErrorClass =
  | "transient"
  | "rate_limited"
  | "auth_expired"
  | "reauth_required"
  | "human_challenge"
  | "unsupported_capability"
  | "validation"
  | "policy_denied"
  | "unknown_outcome"
  | "internal";
export type RetryDecision = "retry" | "give_up" | "needs_user" | "none";

export interface TaskRow {
  id: string;
  workspace_id: string;
  campaign_id: string | null;
  kind: string;
  objective: string;
  state: TaskState;
  current_step: string | null;
  depends_on: string[];
  execution_mode: ExecutionMode;
  retry_policy: Json;
  attempts: number;
  next_run_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  idempotency_key: string;
  input: Json;
  result: Json | null;
  error: Json | null;
  requires_approval: boolean;
  approval_state: ApprovalState;
  approved_by: string | null;
  approved_at: string | null;
  human_intervention: "none" | "requested" | "in_progress" | "resolved";
  intervention_reason: string | null;
  schedule_id: string | null;
  correlation_id: string;
  subject_type: string | null;
  subject_id: string | null;
  priority: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  dead_lettered_at: string | null;
}

export interface TaskEventRow {
  id: string;
  workspace_id: string;
  task_id: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data: Json;
  actor_id: string | null;
  created_at: string;
}

export interface TaskScheduleRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  input: Json;
  execution_mode: ExecutionMode;
  cron: string | null;
  interval_seconds: number | null;
  timezone: string;
  campaign_id: string | null;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionRecordRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  correlation_id: string;
  provider: string;
  account_ref: string | null;
  operation: string;
  mode: "internal" | "api" | "browser";
  attempt: number;
  status: "started" | "succeeded" | "failed" | "unknown";
  started_at: string;
  finished_at: string | null;
  latency_ms: number | null;
  result_meta: Json;
  error_class: ErrorClass | null;
  error_message: string | null;
  retry_decision: RetryDecision;
  artifact_ids: string[];
  external_ref: string | null;
}

export type PublishReceiptStatus = "submitting" | "accepted" | "published" | "partial" | "failed" | "unknown";

export interface PublishReceiptRow {
  id: string;
  workspace_id: string;
  variant_id: string;
  task_id: string | null;
  idempotency_key: string;
  attempt: number;
  mode: "api" | "browser" | "manual";
  provider: string;
  status: PublishReceiptStatus;
  operation_ref: string | null;
  external_ref: string | null;
  external_url: string | null;
  error_class: ErrorClass | null;
  error_code: string | null;
  error_message: string | null;
  parts: Json;
  poll_count: number;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

export interface WorkerIdentityRow {
  id: string;
  workspace_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  modes: ExecutionMode[];
  max_concurrency: number;
  created_by: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  /** 00035 — reported by the executor at claim time (display only). */
  capabilities: Json;
  version: string | null;
}

export type SecretKind =
  | "ai_provider_key"
  | "webhook_signing"
  | "browser_credential"
  | "browser_session_state"
  | "provider_app_credential"
  | "api_token"
  | "other";

export interface SecretRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: SecretKind;
  provider: string | null;
  description: string;
  binding: string | null;
  status: "active" | "revoked" | "deleted";
  current_version: number;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_by: string | null;
  rotated_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  deleted_at: string | null;
}

export interface SecretVersionRow {
  id: string;
  workspace_id: string;
  secret_id: string;
  version: number;
  algorithm: "AES-256-GCM";
  ciphertext: string;
  iv: string;
  auth_tag: string;
  wrapped_dek: string;
  kek_provider: "local" | "vault-transit";
  kek_key_id: string;
  kek_version: number | null;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface SecretAccessEventRow {
  id: string;
  workspace_id: string;
  secret_id: string | null;
  action: "create" | "rotate" | "revoke" | "delete" | "resolve" | "resolve_denied" | "import" | "rewrap";
  actor_type: "user" | "service" | "worker";
  actor_id: string | null;
  purpose: string | null;
  outcome: "success" | "denied" | "error";
  detail: Json;
  created_at: string;
}

export type ArtifactKind =
  | "image"
  | "video"
  | "document"
  | "screenshot"
  | "trace"
  | "export"
  | "import"
  | "bundle"
  | "report"
  | "backup"
  | "other";

export interface ArtifactRow {
  id: string;
  workspace_id: string;
  kind: ArtifactKind;
  object_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  status: "pending_upload" | "available" | "quarantined" | "deleted";
  retention_until: string | null;
  campaign_id: string | null;
  task_id: string | null;
  execution_record_id: string | null;
  metadata: Json;
  created_by: string | null;
  created_by_worker: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
}

export type BrowserSessionStatus =
  | "unverified"
  | "human_login_required"
  | "mfa_required"
  | "challenge_required"
  | "healthy"
  | "degraded"
  | "expired"
  | "revoked";

export interface BrowserSessionRow {
  id: string;
  workspace_id: string;
  platform: string;
  label: string;
  account_hint: string | null;
  status: BrowserSessionStatus;
  storage_state_secret_id: string | null;
  credential_secret_id: string | null;
  capabilities: Json;
  permitted_use_confirmed: boolean;
  permitted_use_confirmed_by: string | null;
  permitted_use_confirmed_at: string | null;
  profile_key: string;
  expires_at: string | null;
  last_verified_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** 00035 */
  allow_experimental: boolean;
  last_check_task_id: string | null;
}

export type CampaignObjective = "awareness" | "engagement" | "lead_generation" | "sales" | "launch" | "community" | "other";
export type CampaignStatus = "draft" | "planned" | "active" | "paused" | "completed" | "archived";

export interface CampaignRow {
  id: string;
  workspace_id: string;
  name: string;
  objective: CampaignObjective;
  status: CampaignStatus;
  owner_id: string | null;
  audience: Json;
  channel_ids: string[];
  voice: string;
  content_plan: Json;
  utm_defaults: Json;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string;
  requires_approval: boolean;
  results: Json;
  notes: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

type Table<Row, Required extends keyof Row> = {
  Row: { [K in keyof Row]: Row[K] };
  Insert: Pick<Row, Required> & Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

export interface SystemHeartbeatRow {
  component: string;
  last_run_at: string;
  last_ok_at: string | null;
  status: "ok" | "degraded" | "failed";
  duration_ms: number | null;
  detail: Json;
}

/** 00036 — campaign attribution */
export interface ContactTouchpointRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  campaign_id: string | null;
  variant_id: string | null;
  channel_id: string | null;
  source: "comment" | "dm" | "form" | "link" | "manual" | "import";
  utm: Json;
  external_ref: string | null;
  landing_url: string | null;
  note: string;
  dedupe_key: string | null;
  occurred_at: string;
  created_by: string | null;
  created_at: string;
}

export interface LeadIntakeTokenRow {
  id: string;
  workspace_id: string;
  name: string;
  token_hash: string;
  default_campaign_id: string | null;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CampaignEngagementRow {
  campaign_id: string;
  comments: number;
  commenters: number;
  touchpoints: number;
  contacts: number;
  first_touch_contacts: number;
}

export type PlatformTables = {
  tasks: Table<TaskRow, "workspace_id" | "kind" | "objective" | "idempotency_key">;
  task_events: Table<TaskEventRow, "workspace_id" | "task_id" | "message">;
  task_schedules: Table<TaskScheduleRow, "workspace_id" | "name" | "kind" | "next_run_at">;
  execution_records: Table<
    ExecutionRecordRow,
    "workspace_id" | "correlation_id" | "provider" | "operation" | "mode"
  >;
  worker_identities: Table<WorkerIdentityRow, "workspace_id" | "name" | "token_hash" | "token_prefix">;
  secrets: Table<SecretRow, "workspace_id" | "name" | "kind">;
  secret_versions: Table<
    SecretVersionRow,
    | "workspace_id"
    | "secret_id"
    | "version"
    | "ciphertext"
    | "iv"
    | "auth_tag"
    | "wrapped_dek"
    | "kek_provider"
    | "kek_key_id"
  >;
  secret_access_events: Table<SecretAccessEventRow, "workspace_id" | "action" | "actor_type">;
  artifacts: Table<ArtifactRow, "workspace_id" | "kind" | "object_key" | "content_type" | "size_bytes" | "sha256">;
  browser_sessions: Table<BrowserSessionRow, "workspace_id" | "platform" | "label">;
  campaigns: Table<CampaignRow, "workspace_id" | "name">;
  system_heartbeats: Table<SystemHeartbeatRow, "component" | "last_run_at" | "status">;
  contact_touchpoints: Table<ContactTouchpointRow, "workspace_id" | "contact_id" | "source">;
  lead_intake_tokens: Table<LeadIntakeTokenRow, "workspace_id" | "name" | "token_hash">;
  publish_receipts: Table<
    PublishReceiptRow,
    "workspace_id" | "variant_id" | "idempotency_key" | "attempt" | "mode" | "provider" | "status"
  >;
  legacy_queue_routes: Table<LegacyQueueRouteRow, "job_type">;
};

/** R8 compatibility seam (migration 00037). Deployment-wide, service-role only. */
export type LegacyQueueTarget = "scheduled_jobs" | "tasks";
export interface LegacyQueueRouteRow {
  job_type: "resume_flow" | "send_broadcast" | "process_social_gateway_event";
  target: LegacyQueueTarget;
  note: string | null;
  updated_at: string;
}
export interface LegacyQueueStatusRow {
  job_type: LegacyQueueRouteRow["job_type"];
  target: LegacyQueueTarget;
  pending: number;
  processing: number;
  failed_7d: number;
  oldest_pending: string | null;
}

export type PlatformFunctions = {
  schedule_flow_resume: { Args: { p_payload: Json; p_run_at: string }; Returns: LegacyQueueTarget };
  legacy_queue_target: { Args: { p_job_type: string }; Returns: LegacyQueueTarget };
  legacy_queue_status: { Args: Record<string, never>; Returns: LegacyQueueStatusRow[] };
  claim_tasks: {
    Args: {
      p_worker: string;
      p_modes: string[];
      p_limit: number;
      p_lease_seconds: number;
      p_workspace_id?: string | null;
      p_max_running?: number | null;
    };
    Returns: TaskRow[];
  };
  heartbeat_task: { Args: { p_task: string; p_worker: string; p_lease_seconds: number }; Returns: boolean };
  complete_task: { Args: { p_task: string; p_worker: string; p_result?: Json | null }; Returns: boolean };
  fail_task: {
    Args: { p_task: string; p_worker: string; p_error: Json; p_decision: string; p_next_run_at?: string | null };
    Returns: string | null;
  };
  defer_task: {
    Args: { p_task: string; p_worker: string; p_next_run_at: string; p_step?: string | null };
    Returns: boolean;
  };
  recover_expired_leases: { Args: Record<string, never>; Returns: number };
  materialize_schedule: {
    Args: { p_schedule: string; p_expected: string; p_following: string };
    Returns: string | null;
  };
  approve_task: { Args: { p_task: string; p_approve: boolean; p_note?: string | null }; Returns: string };
  cancel_task: { Args: { p_task: string; p_reason?: string | null }; Returns: string };
  retry_task: { Args: { p_task: string; p_note?: string | null }; Returns: string };
  campaign_engagement: { Args: { p_workspace: string; p_since?: string }; Returns: CampaignEngagementRow[] };
  record_heartbeat: {
    Args: { p_component: string; p_status: string; p_duration_ms: number | null; p_detail: Json };
    Returns: undefined;
  };
  schedule_content_item: { Args: { p_draft: string; p_at: string | null; p_plan: Json }; Returns: number };
  unschedule_content_item: { Args: { p_draft: string; p_variant?: string | null }; Returns: number };
  confirm_manual_publication: {
    Args: { p_variant: string; p_external_url: string; p_external_ref?: string | null };
    Returns: string;
  };
  resolve_publication: {
    Args: { p_variant: string; p_outcome: "published" | "not_published"; p_external_url?: string | null; p_external_ref?: string | null };
    Returns: string;
  };
  task_log: {
    Args: { p_workspace: string; p_task: string; p_level: string; p_message: string; p_data?: Json };
    Returns: undefined;
  };
};

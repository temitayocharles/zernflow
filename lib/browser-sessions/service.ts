import "server-only";
import type { Json } from "@/lib/types/database";
import type { BrowserSessionRow, BrowserSessionStatus, TaskRow } from "@/lib/types/platform";
import type { ServiceClient, TaskHandler } from "@/lib/tasks/types";
import { recordAudit } from "@/lib/audit";
import { enqueueTask } from "@/lib/tasks/enqueue";
import { InputError, object, text, uuid } from "@/lib/product/validation";
import { notifyOwners } from "@/lib/product/notify";
import { createSecret, deleteSecret, resolveSecret, rotateSecret, SecretError, type SecretIdentity } from "@/lib/secrets/store";
import { browserAdapter } from "@/lib/browser/registry";
import { capabilityOf, type DetectedSessionState } from "@/lib/browser/contract";
import { parseStorageState, StorageStateError, type StorageStateSummary } from "@/lib/browser/storage-state";

/**
 * Browser session lifecycle (BROWSER_AUTOMATION_DESIGN.md §3). All writes use
 * the service client after the route has authorised the caller; the session's
 * storage state lives only in the secret store and is released only to the
 * worker holding the lease on a task for that session.
 */

export const SESSION_COLUMNS =
  "id, workspace_id, platform, label, account_hint, status, storage_state_secret_id, credential_secret_id, capabilities, permitted_use_confirmed, permitted_use_confirmed_by, permitted_use_confirmed_at, profile_key, expires_at, last_verified_at, last_error, created_by, created_at, updated_at, allow_experimental, last_check_task_id";

export const HUMAN_STATES: readonly BrowserSessionStatus[] = ["human_login_required", "mfa_required", "challenge_required", "expired"];

export class SessionError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

async function load(service: ServiceClient, workspaceId: string, sessionId: string): Promise<BrowserSessionRow> {
  const { data, error } = await service.from("browser_sessions").select(SESSION_COLUMNS).eq("workspace_id", workspaceId).eq("id", sessionId).maybeSingle();
  if (error) throw new Error(`browser session lookup failed: ${error.code ?? "unknown"}`);
  if (!data) throw new SessionError(404, "Browser session not found");
  return data as BrowserSessionRow;
}

async function update(service: ServiceClient, s: BrowserSessionRow, patch: Partial<BrowserSessionRow>): Promise<BrowserSessionRow> {
  const { data, error } = await service
    .from("browser_sessions")
    .update(patch as never)
    .eq("workspace_id", s.workspace_id)
    .eq("id", s.id)
    .select(SESSION_COLUMNS)
    .single();
  if (error || !data) throw new SessionError(409, error?.message?.includes("revoked") ? "This session is revoked" : "Browser session could not be updated");
  return data as BrowserSessionRow;
}

export function parseCreateInput(value: unknown) {
  const body = object(value);
  const platform = text(body.platform, "platform", 40, true);
  const adapter = browserAdapter(platform);
  if (!adapter) throw new InputError("No browser adapter exists for that platform");
  return {
    platform,
    label: text(body.label, "label", 200, true),
    accountHint: body.accountHint ? text(body.accountHint, "account hint", 200) : null,
  };
}

export async function createBrowserSession(service: ServiceClient, input: { workspaceId: string; userId: string; platform: string; label: string; accountHint: string | null }) {
  const { data, error } = await service
    .from("browser_sessions")
    .insert({ workspace_id: input.workspaceId, platform: input.platform, label: input.label, account_hint: input.accountHint, created_by: input.userId } as never)
    .select(SESSION_COLUMNS)
    .single();
  if (error || !data) throw new Error(`browser session create failed: ${error?.code ?? "unknown"}`);
  await recordAudit(service, { workspaceId: input.workspaceId, entityType: "browser_sessions", entityId: data.id, actorId: input.userId, action: "browser_session.create", changes: { platform: input.platform, label: input.label } });
  return data as BrowserSessionRow;
}

/** Owner attests permitted use (and optionally enables experimental adapters). */
export async function attestSession(service: ServiceClient, input: { workspaceId: string; sessionId: string; userId: string; confirm: boolean; allowExperimental: boolean }) {
  const s = await load(service, input.workspaceId, input.sessionId);
  if (s.status === "revoked") throw new SessionError(409, "This session is revoked");
  const patch: Partial<BrowserSessionRow> = input.confirm
    ? { permitted_use_confirmed: true, permitted_use_confirmed_by: input.userId, permitted_use_confirmed_at: new Date().toISOString(), allow_experimental: input.allowExperimental }
    : { permitted_use_confirmed: false, permitted_use_confirmed_by: null, permitted_use_confirmed_at: null, allow_experimental: false };
  const next = await update(service, s, patch);
  await recordAudit(service, { workspaceId: s.workspace_id, entityType: "browser_sessions", entityId: s.id, actorId: input.userId, action: input.confirm ? "browser_session.attest" : "browser_session.withdraw_attestation", changes: { allowExperimental: input.confirm && input.allowExperimental } });
  return next;
}

/** Encrypts an imported storage state into the secret store (create or rotate). Never stores or returns plaintext elsewhere. */
export async function importStorageState(
  service: ServiceClient,
  input: { workspaceId: string; sessionId: string; raw: string; identity: SecretIdentity; actorId: string | null },
): Promise<{ session: BrowserSessionRow; summary: StorageStateSummary }> {
  const s = await load(service, input.workspaceId, input.sessionId);
  if (s.status === "revoked") throw new SessionError(409, "This session is revoked");
  const adapter = browserAdapter(s.platform);
  if (!adapter) throw new SessionError(409, "This platform no longer has a browser adapter");
  let parsed: ReturnType<typeof parseStorageState>;
  try {
    parsed = parseStorageState(input.raw, adapter);
  } catch (e) {
    if (e instanceof StorageStateError) throw new SessionError(400, e.message);
    throw e;
  }
  if (!parsed.summary.authCookiesPresent) {
    throw new SessionError(400, `The export does not contain a signed-in ${adapter.label} session (missing ${adapter.signals.authCookies.join(", ")}). Sign in first, then export.`);
  }
  let secretId = s.storage_state_secret_id;
  if (secretId) {
    try {
      await rotateSecret(service, { workspaceId: s.workspace_id, secretId, value: parsed.normalized, identity: input.identity });
    } catch (e) {
      // The previous secret was revoked or deleted from Secrets: start a fresh one.
      if (!(e instanceof SecretError) || (e.code !== "unavailable" && e.code !== "not_found")) throw e;
      secretId = null;
    }
  }
  if (!secretId) {
    const secret = await createSecret(service, {
      workspaceId: s.workspace_id,
      name: `browser-session:${s.id}:${Date.now().toString(36)}`,
      kind: "browser_session_state",
      provider: s.platform,
      description: `Session state for ${adapter.label} browser session “${s.label}”`,
      value: parsed.normalized,
      expiresAt: parsed.summary.expiresAt,
      identity: input.identity,
    });
    secretId = secret.id;
  }
  const session = await update(service, s, {
    storage_state_secret_id: secretId,
    status: "unverified",
    expires_at: parsed.summary.expiresAt,
    last_error: null,
  });
  // Checks parked on the old (signed-out) state are superseded by the new import.
  await service
    .from("tasks")
    .update({ state: "cancelled", finished_at: new Date().toISOString() } as never)
    .eq("workspace_id", s.workspace_id)
    .eq("subject_type", "browser_sessions")
    .eq("subject_id", s.id)
    .eq("kind", "browser.session_check")
    .eq("state", "waiting_for_user");
  await recordAudit(service, { workspaceId: s.workspace_id, entityType: "browser_sessions", entityId: s.id, actorId: input.actorId, action: "browser_session.import_state", changes: { cookies: parsed.summary.cookieCount, origins: parsed.summary.originCount, expiresAt: parsed.summary.expiresAt } });
  return { session, summary: parsed.summary };
}

/** Why a session cannot run a browser check right now (null = it can). */
export function checkBlocker(s: BrowserSessionRow): string | null {
  if (s.status === "revoked") return "This session is revoked.";
  if (!s.storage_state_secret_id) return "Import a signed-in session first.";
  if (!s.permitted_use_confirmed) return "An owner must confirm permitted use first.";
  const adapter = browserAdapter(s.platform);
  if (!adapter) return "No browser adapter exists for this platform.";
  const cap = capabilityOf(adapter, "session_check");
  if (cap.level === "unsupported") return cap.note;
  if (cap.level === "experimental" && !s.allow_experimental) return "Session checks for this platform are experimental; enable experimental support for this session first.";
  return null;
}

export async function requestSessionCheck(
  service: ServiceClient,
  input: { workspaceId: string; sessionId: string; actorId: string | null; reason: "manual" | "import" | "scheduled"; now?: Date },
): Promise<{ taskId: string; created: boolean }> {
  const s = await load(service, input.workspaceId, input.sessionId);
  const blocker = checkBlocker(s);
  if (blocker) throw new SessionError(409, blocker);
  const now = input.now ?? new Date();
  // One check per session per 10-minute window (manual) or per day (scheduled).
  const bucket = input.reason === "scheduled" ? now.toISOString().slice(0, 10) : Math.floor(now.getTime() / 600_000).toString();
  const task = await enqueueTask(service, {
    workspaceId: s.workspace_id,
    kind: "browser.session_check",
    objective: `Check ${browserAdapter(s.platform)!.label} session “${s.label}”`,
    idempotencyKey: `browser-check:${s.id}:${input.reason === "scheduled" ? "d" : "m"}${bucket}`,
    input: { sessionId: s.id, platform: s.platform },
    executionMode: "browser",
    subject: { type: "browser_sessions", id: s.id },
    retryPolicy: { maxAttempts: 2, baseDelayMs: 300_000, maxDelayMs: 1_800_000 },
    createdBy: input.actorId,
  });
  await update(service, s, { last_check_task_id: task.id });
  return { taskId: task.id, created: task.created };
}

/** Revokes the session: crypto-shreds its state and cancels pending browser work. */
export async function revokeBrowserSession(service: ServiceClient, input: { workspaceId: string; sessionId: string; userId: string }) {
  const s = await load(service, input.workspaceId, input.sessionId);
  if (s.status === "revoked") return s;
  const next = await update(service, s, { status: "revoked", allow_experimental: false, last_error: null });
  if (s.storage_state_secret_id) {
    await deleteSecret(service, { workspaceId: s.workspace_id, secretId: s.storage_state_secret_id, identity: { type: "user", id: input.userId } });
  }
  await service
    .from("tasks")
    .update({ state: "cancelled", finished_at: new Date().toISOString() } as never)
    .eq("workspace_id", s.workspace_id)
    .eq("subject_type", "browser_sessions")
    .eq("subject_id", s.id)
    .in("state", ["queued", "retrying", "waiting", "waiting_for_user"]);
  await recordAudit(service, { workspaceId: s.workspace_id, entityType: "browser_sessions", entityId: s.id, actorId: input.userId, action: "browser_session.revoke" });
  return next;
}

// ---------------------------------------------------------------------------
// Worker side (lease already verified by the route)
// ---------------------------------------------------------------------------

function sessionIdOf(task: Pick<TaskRow, "kind" | "input">): string {
  if (!task.kind.startsWith("browser.")) throw new SessionError(403, "Task does not use a browser session");
  const id = (task.input as { sessionId?: unknown } | null)?.sessionId;
  try {
    return uuid(id, "session id");
  } catch {
    throw new SessionError(400, "Task has no browser session");
  }
}

/** Releases the decrypted storage state to the worker holding this task's lease. */
export async function sessionForLeasedTask(service: ServiceClient, task: TaskRow, workerId: string) {
  const s = await load(service, task.workspace_id, sessionIdOf(task));
  const blocker = checkBlocker(s);
  if (blocker) throw new SessionError(409, blocker);
  const adapter = browserAdapter(s.platform)!;
  const secret = await resolveSecret(service, {
    workspaceId: s.workspace_id,
    secretId: s.storage_state_secret_id!,
    purpose: `browser:${task.kind}:${task.id}`,
    identity: { type: "worker", id: workerId, allowedSecretIds: [s.storage_state_secret_id!] },
  });
  return {
    session: { id: s.id, platform: s.platform, label: s.label, profileKey: s.profile_key, allowedHosts: adapter.allowedHosts },
    storageState: JSON.parse(secret.value) as Json,
  };
}

const REPORTABLE: readonly DetectedSessionState[] = ["healthy", "degraded", "human_login_required", "expired", "mfa_required", "challenge_required"];

/** Applies a worker's session-state report for the leased task's session only. */
export async function reportSessionState(
  service: ServiceClient,
  task: TaskRow,
  workerId: string,
  report: { state: unknown; reason: unknown; storageState?: unknown },
) {
  const s = await load(service, task.workspace_id, sessionIdOf(task));
  if (s.status === "revoked") throw new SessionError(409, "This session is revoked");
  if (typeof report.state !== "string" || !REPORTABLE.includes(report.state as DetectedSessionState)) throw new SessionError(400, "Unknown session state");
  const state = report.state as DetectedSessionState;
  const reason = typeof report.reason === "string" ? report.reason.slice(0, 1000) : null;
  const ok = state === "healthy" || state === "degraded";
  const next = await update(service, s, {
    status: state,
    last_error: ok && state === "healthy" ? null : reason,
    ...(ok ? { last_verified_at: new Date().toISOString() } : {}),
  });
  // Refreshed cookies from a healthy run are re-encrypted (same validation as imports).
  if (state === "healthy" && typeof report.storageState === "string" && s.storage_state_secret_id) {
    const adapter = browserAdapter(s.platform)!;
    try {
      const parsed = parseStorageState(report.storageState, adapter);
      if (parsed.summary.authCookiesPresent) {
        await rotateSecret(service, { workspaceId: s.workspace_id, secretId: s.storage_state_secret_id, value: parsed.normalized, identity: { type: "worker", id: workerId, allowedSecretIds: [s.storage_state_secret_id] } });
        if (parsed.summary.expiresAt) await update(service, next, { expires_at: parsed.summary.expiresAt });
      }
    } catch {
      /* keep the previous state; a refresh is an optimisation */
    }
  }
  if (HUMAN_STATES.includes(state) && s.status !== state) {
    await notifyOwners(service, {
      workspaceId: s.workspace_id,
      title: `Browser session “${s.label}” needs you: ${state.replace(/_/g, " ")}`,
      kind: "browser_session_attention",
      entityType: "browser_sessions",
      entityId: s.id,
      dedupeKey: `browser-session:${s.id}:${state}:${new Date().toISOString().slice(0, 10)}`,
    });
  }
  await recordAudit(service, { workspaceId: s.workspace_id, entityType: "browser_sessions", entityId: s.id, actorId: null, action: "browser_session.state_reported", changes: { state, taskId: task.id } });
  return next;
}

export const browserSessionCheckHandler: TaskHandler<{ sessionId: string; platform: string }> = {
  kind: "browser.session_check",
  title: "Browser session check",
  description: "Read-only check that a managed browser session is still signed in. Runs on the external browser executor; stops at any checkpoint or second-factor prompt.",
  mode: "browser",
  schedulable: false,
  userRunnable: false,
  parseInput(input) {
    const o = object(input);
    return { sessionId: uuid(o.sessionId, "session id"), platform: text(o.platform, "platform", 40, true) };
  },
};

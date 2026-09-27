import { createHash } from "node:crypto";
import type { BrowserAdapter, SessionCheckResult } from "../../../lib/browser/contract";
import { STATE_OUTCOME } from "../../../lib/browser/policy";
import { WorkerApiError, type ClaimedTask, type ExecutionSummary, type WorkerClient } from "./client";

export const EXECUTOR_VERSION = "0.1.0";
export const SUPPORTED_KINDS = ["browser.session_check"] as const;

export interface CheckOutput {
  result: SessionCheckResult;
  screenshots: { label: string; bytes: Uint8Array }[];
  /** Refreshed storage state; only read when the session is healthy. */
  storageState: string | null;
}

/** The only thing the loop needs from Playwright; tests substitute a fake. */
export interface BrowserRuntime {
  runSessionCheck(input: { adapter: BrowserAdapter; storageState: unknown; allowedHosts: readonly string[] }): Promise<CheckOutput>;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface LoopDeps {
  client: Pick<WorkerClient, "claim" | "heartbeat" | "session" | "reportSession" | "uploadArtifact" | "complete" | "fail">;
  runtime: BrowserRuntime;
  adapters: readonly BrowserAdapter[];
  log: Logger;
  now?: () => number;
  heartbeatMs?: number;
}

/** Strips query and fragment so tokens in URLs never reach results or logs. */
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

function capabilityList(adapters: readonly BrowserAdapter[]): string[] {
  return adapters.flatMap((a) => a.capabilities.filter((c) => c.level !== "unsupported").map((c) => `${a.platform}:${c.operation}:${c.level}`));
}

function errorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // Playwright messages can echo URLs; keep them short and query-free.
  return m.replace(/https?:\/\/[^\s"')]+/g, (u) => safeUrl(u) || "[url]").slice(0, 300);
}

/**
 * Claims and runs at most one task. Returns "idle" when nothing was claimable.
 * Every path ends in complete or fail so a lease is never silently abandoned
 * (if the process dies, lease expiry + recover_expired_leases requeues it).
 */
export async function runOnce(deps: LoopDeps): Promise<"idle" | "ran"> {
  const now = deps.now ?? Date.now;
  const task = await deps.client.claim({ modes: ["browser"], capabilities: { adapters: capabilityList(deps.adapters) }, version: EXECUTOR_VERSION });
  if (!task) return "idle";
  const started = now();
  const log = (event: string, fields: Record<string, unknown> = {}) => deps.log.info(event, { taskId: task.id, kind: task.kind, correlationId: task.correlationId, attempt: task.attempt, ...fields });
  log("browser_task.claimed");

  const beat = setInterval(() => {
    deps.client.heartbeat(task.id).catch((e) => deps.log.warn("browser_task.heartbeat_failed", { taskId: task.id, error: errorMessage(e) }));
  }, deps.heartbeatMs ?? 60_000);
  try {
    await execute(deps, task, started, now, log);
  } catch (e) {
    deps.log.warn("browser_task.unexpected", { taskId: task.id, error: errorMessage(e) });
    // Best effort; if this also fails, lease expiry requeues the task.
    await deps.client.fail(task.id, { error: { class: "transient", message: `Executor error: ${errorMessage(e)}` } }).catch(() => undefined);
  } finally {
    clearInterval(beat);
  }
  return "ran";
}

async function execute(deps: LoopDeps, task: ClaimedTask, started: number, now: () => number, log: (e: string, f?: Record<string, unknown>) => void) {
  const fail = async (errorClass: string, message: string, execution?: ExecutionSummary) => {
    log("browser_task.failed", { errorClass });
    await deps.client.fail(task.id, { error: { class: errorClass, message }, execution });
  };

  if (!(SUPPORTED_KINDS as readonly string[]).includes(task.kind)) {
    return fail("unsupported_capability", `This executor (v${EXECUTOR_VERSION}) does not run ${task.kind}`);
  }

  let leased;
  try {
    leased = await deps.client.session(task.id);
  } catch (e) {
    if (e instanceof WorkerApiError && (e.status === 403 || e.status === 404 || e.status === 409)) {
      return fail("policy_denied", `Session unavailable: ${e.message}`);
    }
    throw e;
  }

  const adapter = deps.adapters.find((a) => a.platform === leased.session.platform);
  if (!adapter) return fail("unsupported_capability", `No browser adapter for ${leased.session.platform}`);

  const summary = (artifactIds: string[], meta: Record<string, unknown>): ExecutionSummary => ({
    provider: `browser:${adapter.platform}`,
    operation: "session_check",
    latencyMs: Math.max(0, now() - started),
    artifactIds,
    resultMeta: meta,
  });

  let output: CheckOutput;
  try {
    output = await deps.runtime.runSessionCheck({ adapter, storageState: leased.storageState, allowedHosts: leased.session.allowedHosts });
  } catch (e) {
    return fail("transient", `Browser run failed: ${errorMessage(e)}`, summary([], { stage: "browser" }));
  }

  const artifactIds: string[] = [];
  for (const shot of output.screenshots.slice(0, 3)) {
    try {
      const sha256 = createHash("sha256").update(shot.bytes).digest("hex");
      artifactIds.push(await deps.client.uploadArtifact(task.id, { kind: "screenshot", fileName: `${shot.label}.png`, contentType: "image/png", bytes: shot.bytes, sha256 }));
    } catch (e) {
      // Evidence is best-effort (storage may be unconfigured); the check result still counts.
      deps.log.warn("browser_task.artifact_failed", { taskId: task.id, error: errorMessage(e) });
    }
  }

  const { state, reason } = output.result;
  const finalUrl = safeUrl(output.result.finalUrl);
  await deps.client.reportSession(task.id, {
    state,
    reason,
    ...(state === "healthy" && output.storageState ? { storageState: output.storageState } : {}),
  });

  const outcome = STATE_OUTCOME[state];
  const execution = summary(artifactIds, { state, finalUrl });
  if (outcome.ok) {
    log("browser_task.completed", { state });
    await deps.client.complete(task.id, { result: { state, reason, finalUrl }, execution });
  } else {
    await fail(outcome.errorClass!, reason, execution);
  }
}

/**
 * Runs tasks one at a time (MAX_BROWSER_CONCURRENCY is enforced server-side too)
 * until idle (BROWSER_IDLE_SHUTDOWN) or the job's time budget is spent.
 */
export async function runLoop(
  deps: LoopDeps,
  opts: { maxMs: number; idleShutdown: boolean; pollMs: number; shouldStop?: () => boolean; sleep?: (ms: number) => Promise<void> },
): Promise<{ ran: number; reason: "idle" | "time_budget" | "stopped" }> {
  const now = deps.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  let ran = 0;
  while (true) {
    if (opts.shouldStop?.()) return { ran, reason: "stopped" };
    if (now() - start >= opts.maxMs) return { ran, reason: "time_budget" };
    const r = await runOnce(deps);
    if (r === "ran") {
      ran++;
      continue;
    }
    if (opts.idleShutdown) return { ran, reason: "idle" };
    await sleep(opts.pollMs);
  }
}

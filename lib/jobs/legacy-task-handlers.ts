import type { Json } from "@/lib/types/database";
import { TaskError } from "@/lib/tasks/errors";
import { normalizeRetryPolicy } from "@/lib/tasks/retry";
import type { ServiceClient, TaskContext, TaskHandler, TaskOutcome } from "@/lib/tasks/types";
import {
  GatewayOperationPendingError,
  LEGACY_TASK_KINDS,
  type LegacyJobType,
  operationRetryDelayMs,
  processLegacyWork,
  SessionCancelError,
  SessionRecheckError,
  settleFailedWork,
  STALE_INVOCATION_MS,
} from "./legacy-work";

/**
 * Durable task handlers for the three legacy scheduled_jobs types (R8).
 *
 * Parity with the /api/cron/jobs drain:
 *   - same unit-of-work code (lib/jobs/legacy-work.ts);
 *   - same retry budget (3 attempts, ~10 s / ~20 s backoff; the producer
 *     RPCs in migration 00037 set retry_policy) and every ordinary error is
 *     retried, exactly like the legacy drain, regardless of error class;
 *   - "park and look again" outcomes (Gateway operation still pending,
 *     session recheck window) become task deferrals, which do not consume an
 *     attempt (defer_task), matching the legacy attempts rollback;
 *   - on the final attempt or a SessionCancelError the settle side effects
 *     run BEFORE the task is dead-lettered (terminal TaskError).
 *
 * Gateway operation progress is carried in tasks.current_step
 * (`gateway-op:<checks>:<operationId>`) because task input is immutable.
 */

export const SETTLED_STEP = "settled";
const OPERATION_STEP = /^gateway-op:(\d{1,4}):(.{1,160})$/;

export function parseOperationStep(step: string | null | undefined): { checks: number; operationId: string | null } {
  const match = step ? OPERATION_STEP.exec(step) : null;
  if (!match) return { checks: 0, operationId: null };
  return { checks: Number(match[1]), operationId: match[2] === "-" ? null : match[2] };
}

export function formatOperationStep(checks: number, operationId: string | null): string {
  return `gateway-op:${Math.min(checks, 9999)}:${(operationId ?? "-").slice(0, 160)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TaskError("validation", "Task input must be an object");
  }
  return input as Record<string, unknown>;
}

function requireUuid(obj: Record<string, unknown>, key: string): void {
  if (typeof obj[key] !== "string" || !UUID.test(obj[key] as string)) {
    throw new TaskError("validation", `Task input ${key} must be a UUID`);
  }
}

async function markSettled(ctx: TaskContext): Promise<void> {
  const { error } = await ctx.supabase
    .from("tasks")
    .update({ current_step: SETTLED_STEP })
    .eq("id", ctx.task.id)
    .eq("state", "running");
  if (error) console.error(`Failed to mark task ${ctx.task.id} settled; the settle sweep will retry idempotently`);
}

async function runLegacyUnit(ctx: TaskContext, type: LegacyJobType, input: Record<string, unknown>): Promise<TaskOutcome> {
  const ref = { queue: "tasks" as const, id: ctx.task.id };
  const progress = parseOperationStep(ctx.task.current_step);
  try {
    await processLegacyWork(ctx.supabase, type, input as Json, ref, { operationId: progress.operationId });
    return { status: "completed" };
  } catch (error) {
    if (error instanceof GatewayOperationPendingError) {
      const checks = progress.checks + 1;
      return {
        status: "deferred",
        nextRunAt: new Date(Date.now() + operationRetryDelayMs(checks)),
        step: formatOperationStep(checks, error.operationId ?? progress.operationId),
      };
    }
    if (error instanceof SessionRecheckError) {
      return {
        status: "deferred",
        nextRunAt: new Date(Date.now() + STALE_INVOCATION_MS),
        step: ctx.task.current_step ?? undefined,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const policy = normalizeRetryPolicy(ctx.task.retry_policy);
    const final = error instanceof SessionCancelError || ctx.task.attempts >= policy.maxAttempts;
    if (!final) throw new TaskError("internal", message, { cause: error });

    await settleFailedWork({ supabase: ctx.supabase, type, payload: input as Json, ref, errorMessage: message });
    await markSettled(ctx);
    await ctx.event("error", "Legacy work settled as failed", { type });
    throw new TaskError("internal", message, { cause: error, terminal: true });
  }
}

type ResumeInput = Record<string, unknown> & { sessionId: string; nodeId: string; workspaceId: string };
type BroadcastInput = Record<string, unknown> & { broadcastId: string; recipientId: string };
type GatewayEventInput = Record<string, unknown> & { eventId: string; channelId: string; envelope: unknown };

export const flowResumeHandler: TaskHandler<ResumeInput> = {
  kind: LEGACY_TASK_KINDS.resume_flow,
  title: "Resume flow after delay",
  description: "Continues an automation flow session when its delay node elapses.",
  mode: "internal",
  schedulable: false,
  userRunnable: false,
  parseInput(input) {
    const obj = asObject(input);
    requireUuid(obj, "sessionId");
    requireUuid(obj, "workspaceId");
    if (typeof obj.nodeId !== "string" || obj.nodeId.length === 0) {
      throw new TaskError("validation", "Task input nodeId is required");
    }
    return obj as ResumeInput;
  },
  run: (ctx, input) => runLegacyUnit(ctx, "resume_flow", input),
};

export const broadcastDeliverHandler: TaskHandler<BroadcastInput> = {
  kind: LEGACY_TASK_KINDS.send_broadcast,
  title: "Deliver broadcast message",
  description: "Sends one broadcast recipient's message through Agent Social Gateway (idempotent per recipient).",
  mode: "internal",
  schedulable: false,
  userRunnable: false,
  parseInput(input) {
    const obj = asObject(input);
    requireUuid(obj, "broadcastId");
    requireUuid(obj, "recipientId");
    return obj as BroadcastInput;
  },
  run: (ctx, input) => runLegacyUnit(ctx, "send_broadcast", input),
};

export const gatewayEventHandler: TaskHandler<GatewayEventInput> = {
  kind: LEGACY_TASK_KINDS.process_social_gateway_event,
  title: "Process Gateway event",
  description: "Applies a signed Agent Social Gateway webhook event (inbox, comments, automations).",
  mode: "internal",
  schedulable: false,
  userRunnable: false,
  parseInput(input) {
    const obj = asObject(input);
    if (typeof obj.eventId !== "string" || obj.eventId.length === 0) {
      throw new TaskError("validation", "Task input eventId is required");
    }
    requireUuid(obj, "channelId");
    if (obj.envelope === undefined) throw new TaskError("validation", "Task input envelope is required");
    return obj as GatewayEventInput;
  },
  run: (ctx, input) => runLegacyUnit(ctx, "process_social_gateway_event", input),
};

export const LEGACY_TASK_HANDLERS = [flowResumeHandler, broadcastDeliverHandler, gatewayEventHandler];

const TYPE_BY_KIND = Object.fromEntries(
  Object.entries(LEGACY_TASK_KINDS).map(([type, kind]) => [kind, type as LegacyJobType]),
) as Record<string, LegacyJobType>;

/**
 * Maintenance sweep: settles legacy-kind tasks that were dead-lettered
 * without passing through the handler's final path (lease expired on a hung
 * attempt, or input rejected). Mirrors the legacy "attempts exhausted on
 * reclaim" branch, including its conservative session gate.
 */
export async function settleAbandonedLegacyTasks(supabase: ServiceClient, limit = 50) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const kinds = Object.keys(TYPE_BY_KIND);
  const base = () =>
    supabase
      .from("tasks")
      .select("id, kind, input, error, current_step")
      .in("kind", kinds)
      .eq("state", "failed")
      .gte("finished_at", since)
      .order("finished_at", { ascending: true })
      .limit(limit);
  const [unstepped, parked] = await Promise.all([
    base().is("current_step", null),
    base().ilike("current_step", "gateway-op:%"),
  ]);
  if (unstepped.error || parked.error) return { status: "failed" as const, error: "task_read_failed" };

  let settled = 0;
  for (const task of [...(unstepped.data ?? []), ...(parked.data ?? [])].slice(0, limit)) {
    const type = TYPE_BY_KIND[task.kind];
    if (!type) continue;
    const err = task.error as { message?: string } | null;
    await settleFailedWork({
      supabase,
      type,
      payload: task.input,
      ref: { queue: "tasks", id: task.id },
      errorMessage: err?.message ?? "Task failed before completion",
      onlyIfStuckOnDelayNode: true,
    });
    const { error } = await supabase.from("tasks").update({ current_step: SETTLED_STEP }).eq("id", task.id).eq("state", "failed");
    if (!error) settled += 1;
  }
  return { status: "completed" as const, settled };
}

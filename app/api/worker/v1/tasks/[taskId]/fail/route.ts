import type { Json } from "@/lib/types/database";
import { choice, InputError, text } from "@/lib/product/validation";
import { redactString } from "@/lib/observability/log";
import { decisionFor, ERROR_CLASSES, type ClassifiedError } from "@/lib/tasks/errors";
import { computeRetryDelay, normalizeRetryPolicy } from "@/lib/tasks/retry";
import type { ErrorClass } from "@/lib/types/platform";
import { readWorkerJson, workerJson, workerRoute, WorkerApiError } from "@/lib/workers/api";
import { parseExecutionSummary, writeRemoteExecution } from "@/lib/workers/execution-summary";
import { leasedTask } from "@/lib/workers/lease";
import { settleRemotePublish } from "@/lib/publishing/service";
import { logger } from "@/lib/observability/log";

export const runtime = "nodejs";

/**
 * The worker reports an error class; the retry decision is made here from the
 * shared taxonomy, so a worker cannot force retries of human challenges.
 */
export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  return workerRoute(request, async (ctx) => {
    const task = await leasedTask(ctx, (await params).taskId);
    const body = await readWorkerJson(request);
    const raw = body.error;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InputError("error object required");
    const e = raw as Record<string, unknown>;
    const errorClass = choice(e.class, "error class", ERROR_CLASSES) as ErrorClass;
    const message = redactString(text(e.message, "error message", 1000, true));
    const retryAfterMs =
      typeof e.retryAfterMs === "number" && e.retryAfterMs > 0 ? Math.min(e.retryAfterMs, 86_400_000) : undefined;
    const decision = decisionFor(errorClass);
    const classified: ClassifiedError = { class: errorClass, message, retryable: decision === "retry" };
    const execution = parseExecutionSummary(body.execution);
    if (execution) {
      await writeRemoteExecution(ctx.supabase, task, execution, {
        status: errorClass === "unknown_outcome" ? "unknown" : "failed",
        error: classified,
      });
    }
    const delay = retryAfterMs ?? computeRetryDelay(task.attempts, normalizeRetryPolicy(task.retry_policy));
    const { data: state } = await ctx.supabase.rpc("fail_task", {
      p_task: task.id,
      p_worker: ctx.leaseOwner,
      p_error: { class: errorClass, message, retryable: classified.retryable } as Json,
      p_decision: decision,
      p_next_run_at: new Date(Date.now() + delay).toISOString(),
    });
    if (!state) throw new WorkerApiError(409, "Lease not held for this task", "lease_lost");
    await settleRemotePublish(ctx.supabase, task, {
      status: state === "retrying" ? "retrying" : state === "waiting_for_user" ? "waiting_for_user" : "failed",
      message,
      errorClass,
    }).catch((error) => logger.warn("worker.settle_failed", { taskId: task.id, error }));
    return workerJson({ ok: true, state, decision });
  });
}

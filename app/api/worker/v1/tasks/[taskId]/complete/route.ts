import type { Json } from "@/lib/types/database";
import { redact } from "@/lib/observability/log";
import { readWorkerJson, workerJson, workerRoute, WorkerApiError } from "@/lib/workers/api";
import { parseExecutionSummary, writeRemoteExecution } from "@/lib/workers/execution-summary";
import { leasedTask } from "@/lib/workers/lease";
import { settleRemotePublish } from "@/lib/publishing/service";
import { logger } from "@/lib/observability/log";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  return workerRoute(request, async (ctx) => {
    const task = await leasedTask(ctx, (await params).taskId);
    const body = await readWorkerJson(request);
    const execution = parseExecutionSummary(body.execution);
    const result = body.result && typeof body.result === "object" ? (redact(body.result) as Json) : null;
    if (execution) await writeRemoteExecution(ctx.supabase, task, execution, { status: "succeeded" });
    const { data } = await ctx.supabase.rpc("complete_task", {
      p_task: task.id,
      p_worker: ctx.leaseOwner,
      p_result: result,
    });
    if (!data) throw new WorkerApiError(409, "Lease not held for this task", "lease_lost");
    // Subject side effects are best-effort; the publish reconcile sweep repairs any gap.
    await settleRemotePublish(ctx.supabase, task, { status: "completed", result }).catch((error) =>
      logger.warn("worker.settle_failed", { taskId: task.id, error }),
    );
    return workerJson({ ok: true, state: "completed" });
  });
}

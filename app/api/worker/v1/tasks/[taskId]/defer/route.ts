import { InputError, text, timestamp } from "@/lib/product/validation";
import { readWorkerJson, workerJson, workerRoute, WorkerApiError } from "@/lib/workers/api";
import { leasedTask } from "@/lib/workers/lease";

export const runtime = "nodejs";

/** Park the task until external progress is expected; does not consume an attempt. */
export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  return workerRoute(request, async (ctx) => {
    const task = await leasedTask(ctx, (await params).taskId);
    const body = await readWorkerJson(request);
    const nextRunAt = timestamp(body.nextRunAt, "nextRunAt");
    if (Date.parse(nextRunAt) > Date.now() + 7 * 86_400_000) throw new InputError("nextRunAt must be within 7 days");
    const step = body.step === undefined ? null : text(body.step, "step", 200);
    const { data } = await ctx.supabase.rpc("defer_task", {
      p_task: task.id,
      p_worker: ctx.leaseOwner,
      p_next_run_at: nextRunAt,
      p_step: step,
    });
    if (!data) throw new WorkerApiError(409, "Lease not held for this task", "lease_lost");
    return workerJson({ ok: true, state: "waiting" });
  });
}

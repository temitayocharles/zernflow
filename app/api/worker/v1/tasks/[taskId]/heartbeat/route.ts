import { readWorkerJson, workerJson, workerRoute, WorkerApiError } from "@/lib/workers/api";
import { uuid } from "@/lib/product/validation";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  return workerRoute(request, async (ctx) => {
    const taskId = uuid((await params).taskId, "task id");
    const body = await readWorkerJson(request);
    const leaseSeconds =
      typeof body.leaseSeconds === "number" ? Math.min(900, Math.max(60, Math.floor(body.leaseSeconds))) : 300;
    const { data } = await ctx.supabase.rpc("heartbeat_task", {
      p_task: taskId,
      p_worker: ctx.leaseOwner,
      p_lease_seconds: leaseSeconds,
    });
    if (!data) throw new WorkerApiError(409, "Lease not held for this task", "lease_lost");
    return workerJson({ ok: true });
  });
}

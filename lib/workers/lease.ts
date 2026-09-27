import "server-only";
import type { TaskRow } from "@/lib/types/platform";
import { uuid } from "@/lib/product/validation";
import { WorkerApiError, type WorkerContext } from "./api";

/** Loads a task only if this worker currently holds its lease. */
export async function leasedTask(ctx: WorkerContext, taskId: string): Promise<TaskRow> {
  const id = uuid(taskId, "task id");
  const { data } = await ctx.supabase
    .from("tasks")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", ctx.identity.workspace_id)
    .eq("state", "running")
    .eq("lease_owner", ctx.leaseOwner)
    .maybeSingle();
  if (!data) throw new WorkerApiError(409, "Lease not held for this task", "lease_lost");
  return data as TaskRow;
}

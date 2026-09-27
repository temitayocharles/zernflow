import type { TaskScheduleRow } from "@/lib/types/platform";
import { logger } from "@/lib/observability/log";
import { followingRun } from "./cron";
import type { ServiceClient } from "./types";

/**
 * Materializes due schedules. The CAS RPC guarantees one task per expected run
 * even when ticks overlap; the following run is computed here (cron + tz).
 */
export async function materializeDueSchedules(
  supabase: ServiceClient,
  now = new Date(),
  limit = 50,
): Promise<{ due: number; created: number; errors: number }> {
  const { data, error } = await supabase
    .from("task_schedules")
    .select("id, workspace_id, cron, interval_seconds, timezone, next_run_at")
    .eq("enabled", true)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at")
    .limit(limit);
  if (error) throw new Error(`Failed to load schedules: ${error.code ?? "unknown"}`);
  let created = 0;
  let errors = 0;
  for (const schedule of (data ?? []) as Pick<
    TaskScheduleRow,
    "id" | "workspace_id" | "cron" | "interval_seconds" | "timezone" | "next_run_at"
  >[]) {
    try {
      const expected = new Date(schedule.next_run_at);
      const following = followingRun(schedule, expected, now);
      const { data: taskId, error: rpcError } = await supabase.rpc("materialize_schedule", {
        p_schedule: schedule.id,
        p_expected: schedule.next_run_at,
        p_following: following.toISOString(),
      });
      if (rpcError) throw new Error(rpcError.code ?? "rpc_failed");
      if (taskId) created += 1;
    } catch (err) {
      errors += 1;
      logger.error("schedule.materialize_failed", { workspaceId: schedule.workspace_id, scheduleId: schedule.id, error: err });
    }
  }
  return { due: data?.length ?? 0, created, errors };
}

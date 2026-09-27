import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

export class BroadcastScheduleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BroadcastScheduleError";
  }
}

/**
 * Schedule broadcast delivery through the `schedule_broadcast_delivery` RPC
 * (migration 00030). Browser roles can no longer write scheduled_jobs; the RPC
 * checks membership, honors broadcasts.scheduled_for, spaces jobs 100 ms
 * apart, deduplicates per recipient, and sets the broadcast to `scheduled`
 * (future start) or `sending`.
 */
export async function scheduleBroadcastDelivery(
  supabase: SupabaseClient<Database>,
  broadcastId: string,
): Promise<{ scheduledJobs: number }> {
  const { data, error } = await supabase.rpc("schedule_broadcast_delivery", {
    p_broadcast_id: broadcastId,
  });
  if (error) {
    if (error.code === "42501") throw new BroadcastScheduleError("Broadcast not found", 404);
    if (error.code === "23514") throw new BroadcastScheduleError("Broadcast cannot be scheduled in its current state", 409);
    throw new BroadcastScheduleError("Failed to schedule broadcast delivery", 503);
  }
  return { scheduledJobs: data ?? 0 };
}

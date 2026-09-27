import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/types/database";

export interface FlowResumePayload {
  sessionId: string;
  nodeId: string;
  flowId: string;
  channelId: string;
  contactId: string;
  conversationId: string;
  workspaceId: string;
  lateConversationId: string | null;
  lateAccountId: string | null;
  variables: Record<string, string>;
}

/**
 * Enqueues a delay-node resume. schedule_flow_resume (migration 00037)
 * routes it to durable tasks or the legacy scheduled_jobs queue per
 * legacy_queue_routes. If the RPC is unavailable (database not migrated yet)
 * or fails, fall back to the pre-R8 direct insert so a delay node can never
 * lose its resume. Returns the queue that accepted the work.
 */
export async function scheduleFlowResume(
  supabase: SupabaseClient<Database>,
  payload: FlowResumePayload,
  runAt: string,
): Promise<"tasks" | "scheduled_jobs" | "legacy_fallback"> {
  const { data, error } = await supabase.rpc("schedule_flow_resume", {
    p_payload: payload as unknown as Json,
    p_run_at: runAt,
  });
  if (!error && (data === "tasks" || data === "scheduled_jobs")) return data;
  console.warn(
    `schedule_flow_resume unavailable (${error?.code ?? "unexpected result"}); using legacy scheduled_jobs insert for session ${payload.sessionId}`,
  );
  await supabase.from("scheduled_jobs").insert({
    workspace_id: payload.workspaceId,
    type: "resume_flow",
    payload: payload as unknown as Json,
    run_at: runAt,
  });
  return "legacy_fallback";
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { FlowLoadError, resumeSession } from "@/lib/flow-engine/engine";
import { SocialGatewayError } from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import { parseSocialGatewayWebhookEnvelope } from "@/lib/social-gateway/webhook";
import { processSocialGatewayWebhookEvent } from "@/lib/social-gateway/webhook-processor";
import type { Database, Json } from "@/lib/types/database";

/**
 * Work units shared by the legacy scheduled_jobs drain (/api/cron/jobs) and
 * the durable task handlers (flow.resume, broadcast.deliver, gateway.event).
 * Both consumers run exactly this code, so moving a producer from one queue
 * to the other (legacy_queue_routes, migration 00037) cannot change what a
 * unit of work does, only how it is claimed, retried and observed.
 */

export type LegacyJobType = "resume_flow" | "process_social_gateway_event" | "send_broadcast";
export type LegacyClient = SupabaseClient<Database>;

/** Identity of the queue row executing this work (excluded from self-checks). */
export interface WorkRef {
  queue: "scheduled_jobs" | "tasks";
  id: string;
}

export const LEGACY_TASK_KINDS: Record<LegacyJobType, string> = {
  resume_flow: "flow.resume",
  send_broadcast: "broadcast.deliver",
  process_social_gateway_event: "gateway.event",
};

// Signals the consumer to skip retry/backoff and route straight to the
// failed + settle branch (which performs/re-attempts the session cancel).
// Thrown when (a) a resume failed AND the cancel of its session also failed
// (requeuing would strand the session: the retry hits the stale-node guard
// and completes the job), or (b) a reclaimed job found its session stranded
// by a resume invocation that died mid-traversal (retrying cannot help; the
// session must be cancelled and the job is the only evidence of the crash).
export class SessionCancelError extends Error {}

// Thrown when a reclaimed job finds its session moved past the delay node and
// not parked, but WRITTEN TO within the stale window: either a concurrent
// webhook resume is mid-traversal (traverseNodes stamps current_node_id, and
// the updated_at trigger fires, on every node) or a resume crashed moments
// ago. The two are indistinguishable right now, and cancelling would kill a
// live run, so the job is requeued past the window and the next look decides.
export class SessionRecheckError extends Error {}

export class GatewayOperationPendingError extends Error {
  constructor(
    message: string,
    readonly operationId: string | null,
  ) {
    super(message);
  }
}

// An invocation that has not written anything for this long is provably dead:
// used both to reclaim stale job claims and to age flow_sessions.updated_at.
export const STALE_INVOCATION_MS = 5 * 60 * 1000;

export function wasSessionWrittenRecently(updatedAt: string): boolean {
  return new Date(updatedAt).getTime() > Date.now() - STALE_INVOCATION_MS;
}

/** Gateway operation polling backoff: 5 s · 2^(checks-1), capped at 5 minutes. */
export function operationRetryDelayMs(operationChecks: number): number {
  return Math.min(5_000 * 2 ** Math.min(Math.max(operationChecks, 1) - 1, 6), 5 * 60 * 1000);
}

/** Progress carried between attempts of a broadcast delivery. */
export interface BroadcastProgress {
  operationId?: string | null;
}

// A session that moved past a delay node is healthy only if the resume that
// moved it also parked it somewhere recoverable: waiting on input, stamped
// with a later delay's waiting_until (resumeSession clears it before
// traversing, so non-null means a later delay executed), or covered by
// another scheduled resume (crash between the enqueue and the waiting_until
// stamp in executeDelay). An active session with none of these was left by a
// resume invocation that died mid-traversal.
// During the R8 dual-run the other resume may live in EITHER queue, so both
// are checked. Throws on a failed read: unknown state must not be reported as
// unhealthy, or a transient read failure could cancel a live session.
export async function isSessionParkedRecoverably({
  supabase,
  session,
  exclude,
}: {
  supabase: LegacyClient;
  session: { id: string; waiting_for_input: boolean; waiting_until: string | null };
  exclude: WorkRef;
}): Promise<boolean> {
  if (session.waiting_for_input || session.waiting_until) return true;

  let jobs = supabase
    .from("scheduled_jobs")
    .select("id", { count: "exact", head: true })
    .eq("type", "resume_flow")
    .in("status", ["pending", "processing"])
    .contains("payload", { sessionId: session.id });
  if (exclude.queue === "scheduled_jobs") jobs = jobs.neq("id", exclude.id);
  const { count: jobCount, error: jobError } = await jobs;
  if (jobError) {
    throw new Error(`could not check scheduled jobs for session ${session.id}: ${jobError.message}`);
  }
  if ((jobCount ?? 0) > 0) return true;

  let tasks = supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("kind", LEGACY_TASK_KINDS.resume_flow)
    .eq("subject_id", session.id)
    .in("state", ["queued", "retrying", "waiting", "running"]);
  if (exclude.queue === "tasks") tasks = tasks.neq("id", exclude.id);
  const { count: taskCount, error: taskError } = await tasks;
  if (taskError) {
    throw new Error(`could not check resume tasks for session ${session.id}: ${taskError.message}`);
  }
  return (taskCount ?? 0) > 0;
}

interface ResumePayload {
  sessionId: string;
  flowId: string;
  channelId: string;
  contactId: string;
  conversationId: string;
  workspaceId: string;
  nodeId: string;
  lateConversationId?: string | null;
  lateAccountId?: string | null;
  variables?: Record<string, string> | null;
}

async function processResumeFlow(supabase: LegacyClient, payload: ResumePayload, ref: WorkRef) {
  // Check if session is still active
  const { data: session, error: sessionError } = await supabase
    .from("flow_sessions")
    .select("*")
    .eq("id", payload.sessionId)
    .eq("status", "active")
    .single();

  if (!session) {
    // postgrest-js swallows transient failures into { data: null, error };
    // only PGRST116 (zero rows) means the session is genuinely
    // cancelled/completed. Anything else must throw so the job retries
    // with backoff instead of being marked completed.
    if (sessionError && sessionError.code !== "PGRST116") {
      throw new Error(`flow session ${payload.sessionId} could not be loaded: ${sessionError.message}`);
    }
    return;
  }

  // The session moved past the delay node. That alone does not mean the
  // resume succeeded (duplicate jobs left by the old restart bug): a resume
  // whose invocation died mid-traversal (maxDuration, hung fetch, OOM) ALSO
  // moved past it, after advancing current_node_id but before parking the
  // session. Disambiguate before treating the job as satisfied; a stranded
  // session would otherwise sit active forever with no job and no log line.
  if (payload.nodeId && session.current_node_id !== payload.nodeId) {
    const parked = await isSessionParkedRecoverably({ supabase, session, exclude: ref });
    if (parked) return;
    // Not parked, but written to within the stale window: a concurrent
    // webhook resume may be mid-traversal (it clears waiting_for_input before
    // traversing, so the snapshot above shows no markers even for a healthy
    // live run). Cancelling now would kill it; look again once the window
    // has passed and the state is decidable.
    if (wasSessionWrittenRecently(session.updated_at)) {
      throw new SessionRecheckError(
        `session ${payload.sessionId} moved past delay node ${payload.nodeId} and is not parked, but was written recently; a concurrent resume may be mid-traversal`,
      );
    }
    // This reclaimed job is the only evidence of the crash; route to the
    // failed + settle branch (which cancels the session) instead of
    // completing the job and discarding it.
    throw new SessionCancelError(
      `session ${payload.sessionId} moved past delay node ${payload.nodeId} to ${session.current_node_id} but is not waiting and has no scheduled job; a resume invocation died mid-traversal`,
    );
  }

  // Resume from the node after the delay; resumeSession restores variables
  // from the session row and leaves {{message}} untouched because
  // incomingMessage is empty.
  try {
    await resumeSession(supabase, session, {
      triggerId: "",
      flowId: session.flow_id,
      channelId: payload.channelId,
      contactId: payload.contactId,
      conversationId: payload.conversationId,
      workspaceId: payload.workspaceId,
      lateConversationId: payload.lateConversationId || undefined,
      lateAccountId: payload.lateAccountId || undefined,
      variables: payload.variables || undefined,
      incomingMessage: {},
    });
  } catch (err) {
    // A FlowLoadError is thrown before resumeSession advances
    // current_node_id, so the retry cannot hit the stale-node guard above;
    // leave the session active and let the backoff retry recover from the
    // transient failure.
    if (err instanceof FlowLoadError) throw err;

    // Any other throw may have advanced current_node_id past the delay node;
    // the retry would then hit the stale-node guard above and complete,
    // stranding the session as active with no pending job. Cancel it so the
    // failure is explicit.
    const { error: cancelError } = await supabase
      .from("flow_sessions")
      .update({ status: "cancelled" })
      .eq("id", payload.sessionId);
    if (cancelError) {
      // postgrest swallows network failures into { error }, so an unchecked
      // cancel can silently no-op; see SessionCancelError.
      throw new SessionCancelError(
        `resume of session ${payload.sessionId} failed (${
          err instanceof Error ? err.message : String(err)
        }) and the session cancel also failed: ${cancelError.message}`,
      );
    }
    console.error(`Failed to resume flow session ${payload.sessionId} (flow ${session.flow_id}), session cancelled:`, err);
    throw err;
  }
}

async function processGatewayEvent(
  supabase: LegacyClient,
  payload: { eventId?: unknown; channelId?: unknown; envelope?: unknown },
) {
  if (typeof payload.eventId !== "string" || typeof payload.channelId !== "string" || payload.envelope === undefined) {
    throw new Error("Social Gateway event job payload is invalid");
  }

  const envelope = parseSocialGatewayWebhookEnvelope(new TextEncoder().encode(JSON.stringify(payload.envelope)));
  await processSocialGatewayWebhookEvent(supabase, {
    eventId: payload.eventId,
    channelId: payload.channelId,
    envelope,
  });

  const { error: settleError } = await supabase
    .from("webhook_events")
    .update({ status: "completed", completed_at: new Date().toISOString(), last_error: null })
    .eq("event_id", payload.eventId)
    .eq("status", "processing");
  if (settleError) {
    // Do not re-run a completed flow merely because the observability ledger
    // update failed. The queue row still records completion.
    console.error(`Failed to mark Social Gateway event ${payload.eventId} completed:`, settleError);
  }
}

async function processBroadcast(
  supabase: LegacyClient,
  payload: { broadcastId: string; recipientId: string },
  progress: BroadcastProgress,
) {
  const { data: recipient, error: recipientError } = await supabase
    .from("broadcast_recipients")
    .select("*, broadcasts(message_content, workspace_id)")
    .eq("id", payload.recipientId)
    .single();

  if (!recipient) {
    if (recipientError && recipientError.code !== "PGRST116") {
      throw new Error(`broadcast recipient ${payload.recipientId} could not be loaded: ${recipientError.message}`);
    }
    return;
  }
  if (recipient.status !== "pending" && recipient.status !== "sending") return;

  const broadcast = recipient.broadcasts as { message_content: { text?: string }; workspace_id: string } | null;
  const message = broadcast?.message_content?.text?.trim();
  if (!broadcast || !message) throw new Error("Broadcast message content is unavailable");

  // Future-dated broadcasts are `scheduled` until their first job runs;
  // promote so settleBroadcastIfDone (which settles `sending`) completes it.
  await supabase.from("broadcasts").update({ status: "sending" }).eq("id", payload.broadcastId).eq("status", "scheduled");

  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("late_conversation_id")
    .eq("workspace_id", broadcast.workspace_id)
    .eq("contact_id", recipient.contact_id)
    .eq("channel_id", recipient.channel_id)
    .single();
  if (conversationError || !conversation?.late_conversation_id) {
    throw new Error(
      conversationError?.message ?? "Agent Social Gateway conversation is not projected for broadcast recipient",
    );
  }

  const gateway = requireSocialGatewayClient();
  let operationId = progress.operationId ?? undefined;
  let operation;
  try {
    // The idempotency key is identical in both queues, so a unit that moved
    // between queues can never produce a second Gateway send.
    operation = operationId
      ? await gateway.getOperation(operationId)
      : await gateway.replyToConversation(conversation.late_conversation_id, {
          text: message,
          idempotencyKey: `zernflow:broadcast:${payload.recipientId}`,
        });
    operationId = operation.id;
  } catch (error) {
    if (error instanceof SocialGatewayError && error.retryable) {
      throw new GatewayOperationPendingError(
        "Agent Social Gateway broadcast operation is temporarily unavailable",
        operationId ?? null,
      );
    }
    throw error;
  }

  if (operation.status === "pending" || operation.status === "running") {
    const { error: sendingError } = await supabase
      .from("broadcast_recipients")
      .update({ status: "sending" })
      .eq("id", payload.recipientId)
      .in("status", ["pending", "sending"]);
    if (sendingError) throw new Error(sendingError.message);
    throw new GatewayOperationPendingError(`Gateway operation ${operation.id} is ${operation.status}`, operation.id);
  }

  const succeeded = operation.status === "succeeded";
  const errorMessage = succeeded
    ? null
    : operation.error_message ??
      (operation.status === "unknown" ? "Delivery outcome is unknown" : "Agent Social Gateway operation failed");
  const { data: settled, error: settleError } = await supabase
    .from("broadcast_recipients")
    .update(
      succeeded
        ? { status: "sent", sent_at: new Date().toISOString(), error_message: null }
        : { status: "failed", error_message: errorMessage },
    )
    .eq("id", payload.recipientId)
    .in("status", ["pending", "sending"])
    .select("id");
  if (settleError) throw new Error(settleError.message);

  if (settled && settled.length > 0) {
    await supabase.rpc(succeeded ? "increment_broadcast_sent" : "increment_broadcast_failed", {
      b_id: payload.broadcastId,
    });
  }
  await settleBroadcastIfDone(supabase, payload.broadcastId);
}

/**
 * Executes one unit of legacy work. Throws GatewayOperationPendingError /
 * SessionRecheckError (park and look again, not a failure),
 * SessionCancelError (terminal: settle now) or any other error (retry).
 */
export async function processLegacyWork(
  supabase: LegacyClient,
  type: string,
  payload: Json,
  ref: WorkRef,
  progress: BroadcastProgress = {},
): Promise<void> {
  switch (type) {
    case "resume_flow":
      return processResumeFlow(supabase, payload as unknown as ResumePayload, ref);
    case "process_social_gateway_event":
      return processGatewayEvent(supabase, (payload ?? {}) as Record<string, unknown>);
    case "send_broadcast": {
      const p = payload as { broadcastId: string; recipientId: string; operationId?: string };
      return processBroadcast(supabase, p, { operationId: progress.operationId ?? p.operationId ?? null });
    }
    default:
      console.warn(`Unknown job type: ${type}`);
  }
}

// Marks the broadcast completed once no recipient is left unfinished.
// 'sending' counts as unfinished: it is an in-flight (or crashed) send that
// will still be settled to sent/failed.
export async function settleBroadcastIfDone(supabase: LegacyClient, broadcastId: string) {
  const { count } = await supabase
    .from("broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId)
    .in("status", ["pending", "sending"]);

  if (count === 0) {
    await supabase.from("broadcasts").update({ status: "completed" }).eq("id", broadcastId).eq("status", "sending");
  }
}

// A send_broadcast unit out of retries would otherwise leave its recipient
// stuck in 'pending'/'sending' forever (no other work touches the row, and
// settleBroadcastIfDone counts both as unfinished, so the broadcast would stay
// 'sending' too). Settle the recipient as failed; best-effort.
async function settleBroadcastRecipientAsFailed(
  supabase: LegacyClient,
  payload: Json,
  ref: WorkRef,
  errorMessage: string,
) {
  const p = payload as { broadcastId?: string; recipientId?: string } | null;
  if (!p?.broadcastId || !p?.recipientId) return;

  const { data: settled, error } = await supabase
    .from("broadcast_recipients")
    .update({ status: "failed", error_message: errorMessage })
    .eq("id", p.recipientId)
    .in("status", ["pending", "sending"])
    .select();
  if (error) {
    console.error(
      `Failed to settle broadcast recipient ${p.recipientId} after ${ref.queue} ${ref.id} exhausted retries; recipient may be left unfinished:`,
      error,
    );
    return;
  }
  if (settled && settled.length > 0) {
    await supabase.rpc("increment_broadcast_failed", { b_id: p.broadcastId });
  }
  // Run even when no row matched: a previous invocation may have settled the
  // recipient but died before settling the broadcast.
  await settleBroadcastIfDone(supabase, p.broadcastId);
}

/**
 * Side effects of a unit that will not run again (retries exhausted or
 * terminal error). The queue row itself is settled by the caller.
 *
 * onlyIfStuckOnDelayNode (the attempts-exhausted reclaim / lease-expired
 * path) additionally gates the session cancel on the session NOT being
 * healthily parked: a reclaimed unit whose resume actually succeeded before
 * its invocation died leaves the session waiting at a later node, and
 * cancelling it would kill the run mid-way. The catch path must NOT gate: a
 * SessionCancelError re-attempts a cancel for a session whose
 * current_node_id may already have advanced.
 */
export async function settleFailedWork({
  supabase,
  type,
  payload,
  ref,
  errorMessage,
  onlyIfStuckOnDelayNode = false,
}: {
  supabase: LegacyClient;
  type: string;
  payload: Json;
  ref: WorkRef;
  errorMessage: string;
  onlyIfStuckOnDelayNode?: boolean;
}): Promise<void> {
  if (type === "send_broadcast") {
    await settleBroadcastRecipientAsFailed(supabase, payload, ref, errorMessage);
    return;
  }

  if (type === "process_social_gateway_event") {
    const p = payload as { eventId?: string } | null;
    if (!p?.eventId) return;
    const { error: webhookError } = await supabase
      .from("webhook_events")
      .update({ status: "failed", completed_at: null, last_error: errorMessage.slice(0, 4000) })
      .eq("event_id", p.eventId)
      .eq("status", "processing");
    if (webhookError) {
      console.error(`Failed to mark Social Gateway event ${p.eventId} as failed:`, webhookError);
    }
    return;
  }

  if (type !== "resume_flow") return;
  const p = payload as { sessionId?: string; nodeId?: string } | null;
  const sessionId = p?.sessionId;
  if (!sessionId) return;

  if (onlyIfStuckOnDelayNode) {
    const { data: session, error: sessionError } = await supabase
      .from("flow_sessions")
      .select("current_node_id, waiting_for_input, waiting_until, status, updated_at")
      .eq("id", sessionId)
      .single();
    if (sessionError || !session) {
      // Unknown state: do not cancel blind (the session may be healthily
      // waiting at a later node). Log so a possible strand stays visible.
      console.error(
        `Could not load session ${sessionId} to settle after ${ref.queue} ${ref.id} exhausted retries; session may be left active:`,
        sessionError,
      );
      return;
    }
    if (session.status !== "active") return;
    if (p?.nodeId && session.current_node_id !== p.nodeId) {
      try {
        const parked = await isSessionParkedRecoverably({
          supabase,
          session: { id: sessionId, ...session },
          exclude: ref,
        });
        if (parked) return;
      } catch (err) {
        console.error(
          `Could not verify session ${sessionId} state after ${ref.queue} ${ref.id} exhausted retries; session may be left active:`,
          err,
        );
        return;
      }
      // Written to within the stale window: a concurrent resume may be
      // mid-traversal (see SessionRecheckError). Do not cancel blind; the
      // unit is already failed, so log the possible strand instead.
      if (wasSessionWrittenRecently(session.updated_at)) {
        console.error(
          `Session ${sessionId} was written recently after ${ref.queue} ${ref.id} exhausted retries; skipping cancel, session may be left active`,
        );
        return;
      }
    }
  }

  const { error: settleError } = await supabase
    .from("flow_sessions")
    .update({ status: "cancelled" })
    .eq("id", sessionId)
    .eq("status", "active");
  if (settleError) {
    // The unit is already failed and never re-fetched, so this session stays
    // active with no pending work. Log it so the strand is visible.
    console.error(
      `Failed to settle session ${sessionId} after ${ref.queue} ${ref.id} exhausted retries; session left active:`,
      settleError,
    );
  }
}

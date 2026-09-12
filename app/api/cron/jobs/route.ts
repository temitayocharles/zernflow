import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { FlowLoadError, resumeSession } from "@/lib/flow-engine/engine";
import { SocialGatewayError } from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import { parseSocialGatewayWebhookEnvelope } from "@/lib/social-gateway/webhook";
import { processSocialGatewayWebhookEvent } from "@/lib/social-gateway/webhook-processor";
import type { Json } from "@/lib/types/database";

class SessionCancelError extends Error {}
class SessionRecheckError extends Error {}
class GatewayOperationPendingError extends Error {
  constructor(
    message: string,
    readonly operationId: string | null,
  ) {
    super(message);
  }
}
const STALE_INVOCATION_MS = 5 * 60 * 1000;
function wasSessionWrittenRecently(updatedAt: string): boolean {
  return new Date(updatedAt).getTime() > Date.now() - STALE_INVOCATION_MS;
}
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret =
    request.nextUrl.searchParams.get("key") ||
    request.headers.get("authorization")?.replace("Bearer ", "");
  if (!cronSecret || providedSecret !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const supabase = await createServiceClient();
  await supabase
    .from("webhook_events")
    .delete()
    .eq("source", "zernio")
    .eq("status", "completed")
    .lt("received_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
  const staleClaimCutoff = new Date(Date.now() - STALE_INVOCATION_MS).toISOString();
  const { data: jobs, error } = await supabase
    .from("scheduled_jobs")
    .select("*")
    .or(
      `status.eq.pending,and(status.eq.processing,or(claimed_at.lt.${staleClaimCutoff},claimed_at.is.null))`
    )
    .lte("run_at", new Date().toISOString())
    .order("run_at", { ascending: true })
    .limit(20);
  if (error || !jobs) {
    return NextResponse.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }
  let processed = 0;
  let failed = 0;
  const maxAttempts = 3;
  for (const job of jobs) {
    if (job.status === "processing" && !job.claimed_at) {
      const { error: stampError } = await supabase
        .from("scheduled_jobs")
        .update({ claimed_at: new Date().toISOString() })
        .eq("id", job.id)
        .eq("status", "processing")
        .is("claimed_at", null);
      if (stampError) {
        console.error(
          `Failed to stamp claimed_at on unaged job ${job.id}:`,
          stampError
        );
      }
      continue;
    }
    if (job.attempts >= maxAttempts) {
      await failJobAndSettleSession({
        supabase,
        job,
        errorMessage: `Exceeded ${maxAttempts} attempts (stale claim reclaimed)`,
        onlyIfStuckOnDelayNode: true,
      });
      failed++;
      continue;
    }
    const { data: claimed, error: claimError } = await supabase
      .from("scheduled_jobs")
      .update({
        status: "processing",
        attempts: job.attempts + 1,
        claimed_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", job.status)
      .eq("attempts", job.attempts)
      .select();
    if (claimError) {
      console.error(`Failed to claim job ${job.id}:`, claimError);
      continue;
    }
    if (!claimed || claimed.length === 0) continue;
    try {
      await processJob(supabase, job);
      await supabase
        .from("scheduled_jobs")
        .update({ status: "completed" })
        .eq("id", job.id);
      processed++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (err instanceof GatewayOperationPendingError) {
        const payload =
          job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
            ? (job.payload as Record<string, Json>)
            : {};
        const rawChecks = payload.operationChecks;
        const operationChecks =
          typeof rawChecks === "number" && Number.isFinite(rawChecks)
            ? Math.max(0, Math.trunc(rawChecks)) + 1
            : 1;
        const retryDelayMs = Math.min(
          5_000 * 2 ** Math.min(operationChecks - 1, 6),
          5 * 60 * 1000,
        );
        await supabase
          .from("scheduled_jobs")
          .update({
            status: "pending",
            run_at: new Date(Date.now() + retryDelayMs).toISOString(),
            attempts: job.attempts,
            last_error: errorMessage,
            payload: {
              ...payload,
              operationChecks,
              ...(err.operationId ? { operationId: err.operationId } : {}),
            } as unknown as Json,
          })
          .eq("id", job.id);
      } else if (err instanceof SessionRecheckError) {
        await supabase
          .from("scheduled_jobs")
          .update({
            status: "pending",
            run_at: new Date(Date.now() + STALE_INVOCATION_MS).toISOString(),
            attempts: job.attempts,
            last_error: errorMessage,
          })
          .eq("id", job.id);
      } else if (job.attempts + 1 >= maxAttempts || err instanceof SessionCancelError) {
        await failJobAndSettleSession({ supabase, job, errorMessage });
      } else {
        const backoffMs = Math.pow(2, job.attempts + 1) * 5000;
        const retryAt = new Date(Date.now() + backoffMs).toISOString();
        await supabase
          .from("scheduled_jobs")
          .update({
            status: "pending",
            run_at: retryAt,
            last_error: errorMessage,
          })
          .eq("id", job.id);
      }
      failed++;
    }
  }
  const sla = await supabase.rpc("refresh_sla_notifications", {});
  return NextResponse.json({ processed, failed, total: jobs.length,
    slaNotifications: sla.error
      ? { status: "failed", error: "SLA scan unavailable; verify migration 00028 and retry the cron invocation" }
      : { status: "completed", inserted: sla.data, mayHaveMore: (sla.data ?? 0) >= 1000 },
  }, { status: sla.error ? 503 : 200 });
}

async function failJobAndSettleSession({
  supabase,
  job,
  errorMessage,
  onlyIfStuckOnDelayNode = false,
}: {
  supabase: Awaited<ReturnType<typeof createServiceClient>>;
  job: { id: string; type: string; payload: Json };
  errorMessage: string;
  onlyIfStuckOnDelayNode?: boolean;
}) {
  await supabase
    .from("scheduled_jobs")
    .update({ status: "failed", last_error: errorMessage })
    .eq("id", job.id);
  if (job.type === "send_broadcast") {
    await settleBroadcastRecipientAsFailed({ supabase, job, errorMessage });
    return;
  }
  if (job.type === "process_social_gateway_event") {
    const payload = job.payload as { eventId?: string } | null;
    if (!payload?.eventId) return;
    const { error: webhookError } = await supabase
      .from("webhook_events")
      .update({
        status: "failed",
        completed_at: null,
        last_error: errorMessage.slice(0, 4000),
      })
      .eq("event_id", payload.eventId)
      .eq("status", "processing");
    if (webhookError) {
      console.error(
        `Failed to mark Social Gateway event ${payload.eventId} as failed:`,
        webhookError,
      );
    }
    return;
  }
  if (job.type !== "resume_flow") return;
  const payload = job.payload as { sessionId?: string; nodeId?: string } | null;
  const sessionId = payload?.sessionId;
  if (!sessionId) return;
  if (onlyIfStuckOnDelayNode) {
    const { data: session, error: sessionError } = await supabase
      .from("flow_sessions")
      .select("current_node_id, waiting_for_input, waiting_until, status, updated_at")
      .eq("id", sessionId)
      .single();
    if (sessionError || !session) {
      console.error(
        `Could not load session ${sessionId} to settle after job ${job.id} exhausted retries; session may be left active:`,
        sessionError
      );
      return;
    }
    if (session.status !== "active") return;
    if (payload?.nodeId && session.current_node_id !== payload.nodeId) {
      try {
        const parked = await isSessionParkedRecoverably({
          supabase,
          session: { id: sessionId, ...session },
          excludeJobId: job.id,
        });
        if (parked) return;
      } catch (err) {
        console.error(
          `Could not verify session ${sessionId} state after job ${job.id} exhausted retries; session may be left active:`,
          err
        );
        return;
      }
      if (wasSessionWrittenRecently(session.updated_at)) {
        console.error(
          `Session ${sessionId} was written recently after job ${job.id} exhausted retries; skipping cancel, session may be left active`
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
    console.error(
      `Failed to settle session ${sessionId} after job ${job.id} exhausted retries; session left active:`,
      settleError
    );
  }
}

async function settleBroadcastRecipientAsFailed({
  supabase,
  job,
  errorMessage,
}: {
  supabase: Awaited<ReturnType<typeof createServiceClient>>;
  job: { id: string; payload: Json };
  errorMessage: string;
}) {
  const payload = job.payload as {
    broadcastId?: string;
    recipientId?: string;
  } | null;
  if (!payload?.broadcastId || !payload?.recipientId) return;
  const { data: settled, error } = await supabase
    .from("broadcast_recipients")
    .update({ status: "failed", error_message: errorMessage })
    .eq("id", payload.recipientId)
    .in("status", ["pending", "sending"])
    .select();
  if (error) {
    console.error(
      `Failed to settle broadcast recipient ${payload.recipientId} after job ${job.id} exhausted retries; recipient may be left unfinished:`,
      error
    );
    return;
  }
  if (settled && settled.length > 0) {
    await supabase.rpc("increment_broadcast_failed", {
      b_id: payload.broadcastId,
    });
  }
  await settleBroadcastIfDone(supabase, payload.broadcastId);
}

async function isSessionParkedRecoverably({
  supabase,
  session,
  excludeJobId,
}: {
  supabase: Awaited<ReturnType<typeof createServiceClient>>;
  session: { id: string; waiting_for_input: boolean; waiting_until: string | null };
  excludeJobId: string;
}): Promise<boolean> {
  if (session.waiting_for_input || session.waiting_until) return true;
  const { count, error } = await supabase
    .from("scheduled_jobs")
    .select("id", { count: "exact", head: true })
    .eq("type", "resume_flow")
    .in("status", ["pending", "processing"])
    .neq("id", excludeJobId)
    .contains("payload", { sessionId: session.id });
  if (error) {
    throw new Error(
      `could not check scheduled jobs for session ${session.id}: ${error.message}`
    );
  }
  return (count ?? 0) > 0;
}

async function processJob(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  job: { id: string; type: string; payload: Json }
) {
  switch (job.type) {
    case "resume_flow": {
      const payload = job.payload as {
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
      };
      const { data: session, error: sessionError } = await supabase
        .from("flow_sessions")
        .select("*")
        .eq("id", payload.sessionId)
        .eq("status", "active")
        .single();
      if (!session) {
        if (sessionError && sessionError.code !== "PGRST116") {
          throw new Error(
            `flow session ${payload.sessionId} could not be loaded: ${sessionError.message}`
          );
        }
        return;
      }
      if (payload.nodeId && session.current_node_id !== payload.nodeId) {
        const parked = await isSessionParkedRecoverably({
          supabase,
          session,
          excludeJobId: job.id,
        });
        if (parked) return;
        if (wasSessionWrittenRecently(session.updated_at)) {
          throw new SessionRecheckError(
            `session ${payload.sessionId} moved past delay node ${payload.nodeId} and is not parked, but was written recently; a concurrent resume may be mid-traversal`
          );
        }
        throw new SessionCancelError(
          `session ${payload.sessionId} moved past delay node ${payload.nodeId} to ${session.current_node_id} but is not waiting and has no scheduled job; a resume invocation died mid-traversal`
        );
      }
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
        if (err instanceof FlowLoadError) throw err;
        const { error: cancelError } = await supabase
          .from("flow_sessions")
          .update({ status: "cancelled" })
          .eq("id", payload.sessionId);
        if (cancelError) {
          throw new SessionCancelError(
            `resume of session ${payload.sessionId} failed (${
              err instanceof Error ? err.message : String(err)
            }) and the session cancel also failed: ${cancelError.message}`
          );
        }
        console.error(
          `Failed to resume flow session ${payload.sessionId} (flow ${session.flow_id}), session cancelled:`,
          err
        );
        throw err;
      }
      break;
    }
    case "process_social_gateway_event": {
      const payload = job.payload as {
        eventId?: unknown;
        channelId?: unknown;
        envelope?: unknown;
      };
      if (
        typeof payload.eventId !== "string" ||
        typeof payload.channelId !== "string" ||
        payload.envelope === undefined
      ) {
        throw new Error("Social Gateway event job payload is invalid");
      }
      const envelope = parseSocialGatewayWebhookEnvelope(
        new TextEncoder().encode(JSON.stringify(payload.envelope)),
      );
      await processSocialGatewayWebhookEvent(supabase, {
        eventId: payload.eventId,
        channelId: payload.channelId,
        envelope,
      });
      const { error: settleError } = await supabase
        .from("webhook_events")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("event_id", payload.eventId)
        .eq("status", "processing");
      if (settleError) {
        console.error(
          `Failed to mark Social Gateway event ${payload.eventId} completed:`,
          settleError,
        );
      }
      break;
    }
    case "send_broadcast": {
      const payload = job.payload as {
        broadcastId: string;
        recipientId: string;
        operationId?: string;
        operationChecks?: number;
      };
      const { data: recipient, error: recipientError } = await supabase
        .from("broadcast_recipients")
        .select("*, broadcasts(message_content, workspace_id)")
        .eq("id", payload.recipientId)
        .single();
      if (!recipient) {
        if (recipientError && recipientError.code !== "PGRST116") {
          throw new Error(
            `broadcast recipient ${payload.recipientId} could not be loaded: ${recipientError.message}`,
          );
        }
        return;
      }
      if (recipient.status !== "pending" && recipient.status !== "sending") {
        return;
      }
      const broadcast = recipient.broadcasts as {
        message_content: { text?: string };
        workspace_id: string;
      } | null;
      const message = broadcast?.message_content?.text?.trim();
      if (!broadcast || !message) {
        throw new Error("Broadcast message content is unavailable");
      }
      const { data: conversation, error: conversationError } = await supabase
        .from("conversations")
        .select("late_conversation_id")
        .eq("workspace_id", broadcast.workspace_id)
        .eq("contact_id", recipient.contact_id)
        .eq("channel_id", recipient.channel_id)
        .single();
      if (conversationError || !conversation?.late_conversation_id) {
        throw new Error(
          conversationError?.message ??
            "Agent Social Gateway conversation is not projected for broadcast recipient",
        );
      }
      const gateway = requireSocialGatewayClient();
      let operationId = payload.operationId;
      let operation;
      try {
        operation = operationId
          ? await gateway.getOperation(operationId)
          : await gateway.replyToConversation(
              conversation.late_conversation_id,
              {
                text: message,
                idempotencyKey: `zernflow:broadcast:${payload.recipientId}`,
              },
            );
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
        throw new GatewayOperationPendingError(
          `Gateway operation ${operation.id} is ${operation.status}`,
          operation.id,
        );
      }
      const succeeded = operation.status === "succeeded";
      const errorMessage = succeeded
        ? null
        : operation.error_message ??
          (operation.status === "unknown"
            ? "Delivery outcome is unknown"
            : "Agent Social Gateway operation failed");
      const { data: settled, error: settleError } = await supabase
        .from("broadcast_recipients")
        .update(
          succeeded
            ? {
                status: "sent",
                sent_at: new Date().toISOString(),
                error_message: null,
              }
            : {
                status: "failed",
                error_message: errorMessage,
              },
        )
        .eq("id", payload.recipientId)
        .in("status", ["pending", "sending"])
        .select("id");
      if (settleError) throw new Error(settleError.message);
      if (settled && settled.length > 0) {
        await supabase.rpc(
          succeeded ? "increment_broadcast_sent" : "increment_broadcast_failed",
          { b_id: payload.broadcastId },
        );
      }
      await settleBroadcastIfDone(supabase, payload.broadcastId);
      break;
    }
    default:
      console.warn(`Unknown job type: ${job.type}`);
  }
}

async function settleBroadcastIfDone(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  broadcastId: string
) {
  const { count } = await supabase
    .from("broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId)
    .in("status", ["pending", "sending"]);
  if (count === 0) {
    await supabase
      .from("broadcasts")
      .update({ status: "completed" })
      .eq("id", broadcastId)
      .eq("status", "sending");
  }
}

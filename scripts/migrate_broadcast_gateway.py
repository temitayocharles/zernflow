from pathlib import Path

path = Path("app/api/cron/jobs/route.ts")
text = path.read_text()

import_marker = 'import { FlowLoadError, resumeSession } from "@/lib/flow-engine/engine";\n'
import_replacement = import_marker + '''import {
  SocialGatewayError,
} from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
'''
if text.count(import_marker) != 1:
    raise SystemExit("flow engine import marker was not found exactly once")
text = text.replace(import_marker, import_replacement, 1)

class_marker = "class SessionRecheckError extends Error {}\n"
class_replacement = class_marker + '''
class GatewayOperationPendingError extends Error {
  constructor(
    message: string,
    readonly operationId: string | null,
  ) {
    super(message);
  }
}
'''
if text.count(class_marker) != 1:
    raise SystemExit("session recheck marker was not found exactly once")
text = text.replace(class_marker, class_replacement, 1)

catch_marker = '''      if (err instanceof SessionRecheckError) {
        // Requeue past the recency window and undo the claim's attempts bump:
        // a recheck is not a failure, and letting rechecks exhaust attempts
        // would route a possibly-live session into the terminal cancel below.
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
'''
catch_replacement = '''      if (err instanceof GatewayOperationPendingError) {
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
        // Requeue past the recency window and undo the claim's attempts bump:
        // a recheck is not a failure, and letting rechecks exhaust attempts
        // would route a possibly-live session into the terminal cancel below.
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
'''
if text.count(catch_marker) != 1:
    raise SystemExit("job catch marker was not found exactly once")
text = text.replace(catch_marker, catch_replacement, 1)

start_marker = '    case "send_broadcast": {\n'
end_marker = '    default:\n'
start = text.find(start_marker)
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit("broadcast job markers were not found")
replacement = '''    case "send_broadcast": {
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

'''
text = text[:start] + replacement + text[end:]
path.write_text(text)

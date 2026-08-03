from __future__ import annotations

from pathlib import Path


def replace_once_or_done(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    target.write_text(text.replace(old, new, 1))


replace_once_or_done(
    "lib/comment-processor.ts",
    '''export async function processComment({
  supabase,
  channel,
  comment,
}: {
  supabase: SupabaseClient<Database>;
  channel: Channel;
  comment: IncomingComment;
}): Promise<ProcessCommentResult> {
''',
    '''export async function processComment({
  supabase,
  channel,
  comment,
  gatewayConversationId,
}: {
  supabase: SupabaseClient<Database>;
  channel: Channel;
  comment: IncomingComment;
  gatewayConversationId?: string;
}): Promise<ProcessCommentResult> {
''',
)

replace_once_or_done(
    "lib/comment-processor.ts",
    '''    .select("id")
    .eq("channel_id", channel.id)
    .eq("platform_comment_id", comment.id)
    .maybeSingle();

  if (alreadyLogged) return { matched: false, skipped: "already_processed" };
''',
    '''    .select("id, error")
    .eq("channel_id", channel.id)
    .eq("platform_comment_id", comment.id)
    .maybeSingle();

  if (alreadyLogged && !alreadyLogged.error) {
    return { matched: false, skipped: "already_processed" };
  }
''',
)

replace_once_or_done(
    "lib/comment-processor.ts",
    '''          platform: channel.platform,
          status: "open",
''',
    '''          platform: channel.platform,
          ...(gatewayConversationId
            ? { late_conversation_id: gatewayConversationId }
            : {}),
          status: "open",
''',
)

replace_once_or_done(
    "lib/types/database.ts",
    '''      scheduled_jobs: {
        Row: {
          id: string;
          type: string;
          payload: Json;
          run_at: string;
          status: JobStatus;
          attempts: number;
          last_error: string | null;
          claimed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          type: string;
          payload: Json;
          run_at: string;
          status?: JobStatus;
          attempts?: number;
          last_error?: string | null;
          claimed_at?: string | null;
          created_at?: string;
        };
        Update: {
          status?: JobStatus;
          attempts?: number;
          last_error?: string | null;
          claimed_at?: string | null;
        };
        Relationships: [];
      };
''',
    '''      scheduled_jobs: {
        Row: {
          id: string;
          type: string;
          payload: Json;
          run_at: string;
          status: JobStatus;
          attempts: number;
          last_error: string | null;
          claimed_at: string | null;
          dedupe_key: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          type: string;
          payload: Json;
          run_at: string;
          status?: JobStatus;
          attempts?: number;
          last_error?: string | null;
          claimed_at?: string | null;
          dedupe_key?: string | null;
          created_at?: string;
        };
        Update: {
          status?: JobStatus;
          attempts?: number;
          last_error?: string | null;
          claimed_at?: string | null;
          dedupe_key?: string | null;
        };
        Relationships: [];
      };
''',
)

replace_once_or_done(
    "lib/types/database.ts",
    '''      increment_broadcast_failed: {
        Args: {
          b_id: string;
        };
        Returns: undefined;
      };
''',
    '''      increment_broadcast_failed: {
        Args: {
          b_id: string;
        };
        Returns: undefined;
      };
      claim_social_gateway_webhook: {
        Args: {
          p_event_id: string;
          p_delivery_id: string;
          p_event_type: string;
          p_channel_id: string;
          p_envelope: Json;
        };
        Returns: string;
      };
      apply_social_gateway_inbound_conversation: {
        Args: {
          p_conversation_id: string;
          p_occurred_at: string;
          p_preview: string;
          p_gateway_conversation_id: string | null;
        };
        Returns: undefined;
      };
''',
)

replace_once_or_done(
    "app/api/cron/jobs/route.ts",
    '''import {
  SocialGatewayError,
} from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import type { Json } from "@/lib/types/database";
''',
    '''import { SocialGatewayError } from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import { parseSocialGatewayWebhookEnvelope } from "@/lib/social-gateway/webhook";
import { processSocialGatewayWebhookEvent } from "@/lib/social-gateway/webhook-processor";
import type { Json } from "@/lib/types/database";
''',
)

replace_once_or_done(
    "app/api/cron/jobs/route.ts",
    '''  if (job.type === "send_broadcast") {
    await settleBroadcastRecipientAsFailed({ supabase, job, errorMessage });
    return;
  }

  if (job.type !== "resume_flow") return;
''',
    '''  if (job.type === "send_broadcast") {
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
''',
)

replace_once_or_done(
    "app/api/cron/jobs/route.ts",
    '''    case "send_broadcast": {
''',
    '''    case "process_social_gateway_event": {
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
        // Do not re-run a completed flow merely because the observability
        // ledger update failed. The scheduled job still records completion.
        console.error(
          `Failed to mark Social Gateway event ${payload.eventId} completed:`,
          settleError,
        );
      }
      break;
    }

    case "send_broadcast": {
''',
)

replace_once_or_done(
    ".env.example",
    '''SOCIAL_GATEWAY_TIMEOUT_MS=10000

# Legacy hosted-Zernio migration mode
''',
    '''SOCIAL_GATEWAY_TIMEOUT_MS=10000
# Shared HMAC secret used only to verify signed event deliveries from the
# gateway. Store the same value in Vault at the endpoint's secret_ref.
SOCIAL_GATEWAY_WEBHOOK_SECRET=replace-with-random-webhook-secret-at-least-24-characters

# Legacy hosted-Zernio migration mode
''',
)

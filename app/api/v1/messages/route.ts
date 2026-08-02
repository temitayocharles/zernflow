import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  SocialGatewayConfigurationError,
  SocialGatewayError,
} from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import type { GatewayMessage, GatewayOperation } from "@/lib/social-gateway/types";
import { createClient } from "@/lib/supabase/server";

interface LocalConversationReference {
  id: string;
  late_conversation_id: string | null;
  workspace_id: string;
}

interface SendMessageBody {
  conversationId?: unknown;
  text?: unknown;
  idempotencyKey?: unknown;
  replyToMessageId?: unknown;
}

function gatewayErrorResponse(error: unknown, action: string): NextResponse {
  if (error instanceof SocialGatewayConfigurationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
  }
  if (error instanceof SocialGatewayError) {
    const status = error.status && error.status >= 400 ? error.status : 502;
    return NextResponse.json(
      { error: error.message, code: error.code, retryable: error.retryable },
      { status },
    );
  }

  console.error(`Failed to ${action} through Agent Social Gateway:`, error);
  return NextResponse.json(
    { error: `Failed to ${action}`, code: "social_gateway_unexpected_error" },
    { status: 500 },
  );
}

function mapGatewayMessage(message: GatewayMessage, localConversationId: string) {
  return {
    id: message.id,
    conversation_id: localConversationId,
    direction: message.direction,
    text: message.text,
    attachments: message.attachments.length > 0 ? message.attachments : null,
    quick_reply_payload: null,
    postback_payload: null,
    callback_data: null,
    platform_message_id: message.external_message_ref,
    sent_by_flow_id: null,
    sent_by_node_id: null,
    sent_by_user_id: null,
    status: message.delivery_state || "sent",
    created_at: message.occurred_at,
  };
}

async function getLocalConversation(
  conversationId: string,
): Promise<LocalConversationReference | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("conversations")
    .select("id, late_conversation_id, workspace_id")
    .eq("id", conversationId)
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * GET /api/v1/messages?conversationId=...
 *
 * Agent Social Gateway is authoritative for provider messages. The historical
 * late_conversation_id column is temporarily retained as the remote gateway
 * conversation identifier until the database naming migration is complete.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conversationId = request.nextUrl.searchParams.get("conversationId")?.trim();
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  const conversation = await getLocalConversation(conversationId);
  if (!conversation?.late_conversation_id) {
    return NextResponse.json(
      { error: "Conversation is not linked to Agent Social Gateway" },
      { status: 404 },
    );
  }

  try {
    const gateway = requireSocialGatewayClient();
    const detail = await gateway.getConversation(conversation.late_conversation_id, {
      messageLimit: 200,
    });
    return NextResponse.json(
      detail.messages.map((message) => mapGatewayMessage(message, conversationId)),
    );
  } catch (error) {
    return gatewayErrorResponse(error, "fetch messages");
  }
}

/**
 * POST /api/v1/messages
 *
 * Queues an operator reply through the gateway's durable outbox. The response
 * remains message-shaped for the inbox optimistic update and includes the
 * operation identifier for later reconciliation.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: SendMessageBody;
  try {
    body = (await request.json()) as SendMessageBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const replyToMessageId =
    typeof body.replyToMessageId === "string" && body.replyToMessageId.trim()
      ? body.replyToMessageId.trim()
      : undefined;

  if (!conversationId || !text) {
    return NextResponse.json(
      { error: "conversationId and non-empty text required" },
      { status: 400 },
    );
  }
  if (text.length > 10_000) {
    return NextResponse.json({ error: "text exceeds 10000 characters" }, { status: 400 });
  }

  const conversation = await getLocalConversation(conversationId);
  if (!conversation?.late_conversation_id) {
    return NextResponse.json(
      { error: "Conversation is not linked to Agent Social Gateway" },
      { status: 404 },
    );
  }

  const suppliedIdempotencyKey =
    typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const idempotencyKey =
    suppliedIdempotencyKey || `zernflow:${user.id}:${conversationId}:${randomUUID()}`;
  if (idempotencyKey.length > 255) {
    return NextResponse.json(
      { error: "idempotencyKey exceeds 255 characters" },
      { status: 400 },
    );
  }

  try {
    const gateway = requireSocialGatewayClient();
    const operation: GatewayOperation = await gateway.replyToConversation(
      conversation.late_conversation_id,
      { text, idempotencyKey, replyToMessageId },
    );
    const createdAt = operation.created_at || new Date().toISOString();

    const { error: updateError } = await supabase
      .from("conversations")
      .update({
        last_message_at: createdAt,
        last_message_preview: text.slice(0, 100),
      })
      .eq("id", conversationId);
    if (updateError) {
      console.error("Gateway reply queued but local conversation metadata update failed:", {
        conversationId,
        operationId: operation.id,
        updateError,
      });
    }

    return NextResponse.json(
      {
        id: operation.message_id ?? operation.id,
        conversation_id: conversationId,
        direction: "outbound",
        text,
        attachments: null,
        quick_reply_payload: null,
        postback_payload: null,
        callback_data: null,
        platform_message_id: operation.external_reference,
        sent_by_flow_id: null,
        sent_by_node_id: null,
        sent_by_user_id: user.id,
        status: operation.status,
        created_at: createdAt,
        operation_id: operation.id,
        idempotency_key: operation.idempotency_key,
      },
      { status: 202 },
    );
  } catch (error) {
    return gatewayErrorResponse(error, "send message");
  }
}

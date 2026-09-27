import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import type { FlowExecutionContext, AiResponseNodeData } from "../types";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import { flowReplyIdempotencyKey } from "../gateway-message";
import { generateText, createGateway } from "ai";
import { resolveBindingOrNull, SECRET_BINDINGS } from "@/lib/secrets/store";
import { logger } from "@/lib/observability/log";

// Halt the run: continuing would let a downstream Send Message deliver the
// literal "{{ai_response}}" token to the contact (same pause mechanism as
// humanTakeover, but the session is cancelled rather than completed).
async function cancelRun(
  supabase: SupabaseClient<Database>,
  sessionId: string
): Promise<"pause"> {
  await supabase
    .from("flow_sessions")
    .update({ status: "cancelled" })
    .eq("id", sessionId);
  return "pause";
}

export async function executeAiResponse(
  supabase: SupabaseClient<Database>,
  data: AiResponseNodeData,
  context: FlowExecutionContext,
  sessionId: string,
  nodeId = "ai-response",
) {
  // AI key precedence: secret store binding `ai.gateway_key` (R3) → legacy
  // workspace column (server-only since 00030, importable via
  // /api/v1/secrets/import-legacy) → deployment AI Gateway key. A configured
  // but unusable secret fails closed rather than silently using another key.
  let storedKey: string | null;
  try {
    storedKey = await resolveBindingOrNull(supabase, {
      workspaceId: context.workspaceId,
      binding: SECRET_BINDINGS.aiGatewayKey,
      purpose: "flow.ai_response",
      identity: { type: "service", id: "flow-engine" },
    });
  } catch (err) {
    logger.error("ai_response.secret_unavailable", {
      workspaceId: context.workspaceId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return cancelRun(supabase, sessionId);
  }
  const { data: workspace } = storedKey
    ? { data: null }
    : await supabase.from("workspaces").select("ai_api_key").eq("id", context.workspaceId).single();

  // Replies go through Agent Social Gateway; legacy Zernio is no longer used.
  let lateConversationId = context.lateConversationId;
  if (!lateConversationId) {
    const { data: conversation } = await supabase
      .from("conversations")
      .select("late_conversation_id")
      .eq("id", context.conversationId)
      .eq("workspace_id", context.workspaceId)
      .single();

    if (!conversation?.late_conversation_id) {
      console.error("AI response skipped: no Gateway conversation is projected", {
        conversationId: context.conversationId,
      });
      return cancelRun(supabase, sessionId);
    }
    lateConversationId = conversation.late_conversation_id;
  }

  // Fetch last N messages from the conversation for context
  const contextMessages = data.contextMessages || 10;
  const { data: recentMessages } = await supabase
    .from("messages")
    .select("direction, text")
    .eq("conversation_id", context.conversationId)
    .order("created_at", { ascending: false })
    .limit(contextMessages);

  // Build messages array for the AI
  const aiMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

  if (recentMessages && recentMessages.length > 0) {
    // Reverse to get chronological order (oldest first)
    const chronological = [...recentMessages].reverse();
    for (const msg of chronological) {
      if (!msg.text) continue;
      aiMessages.push({
        role: msg.direction === "inbound" ? "user" : "assistant",
        content: msg.text,
      });
    }
  }

  try {
    const model = data.model || "openai/gpt-4o-mini";
    const aiGatewayKey = storedKey || workspace?.ai_api_key || process.env.AI_GATEWAY_API_KEY;
    const gw = createGateway({ apiKey: aiGatewayKey || undefined });
    const result = await generateText({
      model: gw(model),
      system: data.systemPrompt || "You are a helpful customer support agent.",
      messages: aiMessages,
      temperature: data.temperature ?? 0.7,
      maxOutputTokens: data.maxTokens ?? 500,
    });

    const text = result.text;

    // Expose the generated text to downstream nodes as {{ai_response}}
    context.variables = { ...(context.variables ?? {}), ai_response: text };

    if (data.sendDirectly !== false) {
      const gateway = requireSocialGatewayClient();
      const operation = await gateway.replyToConversation(lateConversationId, {
        text,
        idempotencyKey: flowReplyIdempotencyKey({
          workspaceId: context.workspaceId,
          flowId: context.flowId,
          sessionId,
          nodeId,
          messageIndex: 0,
        }),
      });
      if (operation.status === "failed") {
        throw new Error(operation.error_message ?? "Agent Social Gateway rejected the AI reply");
      }

      // Store outbound message
      await supabase.from("messages").insert({
        conversation_id: context.conversationId,
        direction: "outbound",
        text,
        attachments: null,
        sent_by_flow_id: context.flowId,
        sent_by_node_id: nodeId,
        platform_message_id: operation.external_reference ?? null,
        status: operation.status === "succeeded" ? "sent" : "pending",
      });

      await supabase.from("analytics_events").insert({
        workspace_id: context.workspaceId,
        flow_id: context.flowId,
        contact_id: context.contactId,
        event_type: "message_sent",
      });
    }
  } catch (error) {
    console.error("Failed to generate or send AI response", {
      flowId: context.flowId,
      error: error instanceof Error ? error.name : "unknown",
    });

    await supabase.from("messages").insert({
      conversation_id: context.conversationId,
      direction: "outbound",
      text: "[AI response failed]",
      sent_by_flow_id: context.flowId,
      status: "failed",
    });

    await supabase.from("analytics_events").insert({
      workspace_id: context.workspaceId,
      flow_id: context.flowId,
      contact_id: context.contactId,
      event_type: "message_failed",
      metadata: { error: error instanceof Error ? error.name : "Unknown error" },
    });

    return cancelRun(supabase, sessionId);
  }
}

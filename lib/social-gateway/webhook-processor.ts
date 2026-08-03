import type { SupabaseClient } from "@supabase/supabase-js";
import { processComment } from "@/lib/comment-processor";
import { executeFlow } from "@/lib/flow-engine/engine";
import { matchTrigger } from "@/lib/flow-engine/trigger-matcher";
import { upsertContactForSender } from "@/lib/inbox-sync";
import type { Database, Json } from "@/lib/types/database";
import type { SocialGatewayWebhookEnvelope } from "./webhook";

type Channel = Database["public"]["Tables"]["channels"]["Row"];
type GatewayMetadata = Record<string, unknown>;

export interface ProcessSocialGatewayWebhookInput {
  eventId: string;
  channelId: string;
  envelope: SocialGatewayWebhookEnvelope;
}

function metadataString(metadata: GatewayMetadata, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataBoolean(metadata: GatewayMetadata, key: string): boolean {
  return metadata[key] === true;
}

function messagePreview(envelope: SocialGatewayWebhookEnvelope): string {
  const text = envelope.data.content.text?.trim();
  if (text) return text.slice(0, 100);
  const firstAttachment = envelope.data.content.attachments[0];
  return firstAttachment ? `[${firstAttachment.type}]` : "[Message]";
}

function isCommentEvent(envelope: SocialGatewayWebhookEnvelope): boolean {
  return (
    envelope.type === "comment.received" ||
    (envelope.type === "reply.received" && envelope.data.metadata.source_kind === "change")
  );
}

export async function processSocialGatewayWebhookEvent(
  supabase: SupabaseClient<Database>,
  input: ProcessSocialGatewayWebhookInput,
): Promise<void> {
  if (input.envelope.id !== input.eventId) {
    throw new Error("queued Social Gateway event identity does not match its envelope");
  }

  const { data: channel, error: channelError } = await supabase
    .from("channels")
    .select("*")
    .eq("id", input.channelId)
    .eq("late_account_id", input.envelope.provider_account_id)
    .eq("is_active", true)
    .single();

  if (channelError || !channel) {
    throw new Error(
      channelError?.message ?? "projected Social Gateway channel is no longer active",
    );
  }

  if (isCommentEvent(input.envelope)) {
    await processGatewayComment(supabase, channel, input.envelope);
    return;
  }

  if (input.envelope.type === "message.received" || input.envelope.type === "reply.received") {
    await processGatewayMessage(supabase, channel, input.envelope);
    return;
  }

  if (input.envelope.type === "event.unsupported") {
    await supabase.from("analytics_events").insert({
      workspace_id: channel.workspace_id,
      event_type: "gateway_event_unsupported",
      metadata: {
        eventId: input.envelope.id,
        provider: input.envelope.provider,
        reason: metadataString(input.envelope.data.metadata, "reason"),
      } as unknown as Json,
    });
  }
  // Delivery-state events remain authoritative in Agent Social Gateway. ZernFlow
  // does not mirror message rows, so there is no local delivery row to mutate.
}

async function processGatewayMessage(
  supabase: SupabaseClient<Database>,
  channel: Channel,
  envelope: SocialGatewayWebhookEnvelope,
): Promise<void> {
  const metadata = envelope.data.metadata;
  if (metadataBoolean(metadata, "is_echo")) return;

  const senderId = envelope.data.actor.external_id;
  if (!senderId) {
    await supabase.from("analytics_events").insert({
      workspace_id: channel.workspace_id,
      event_type: "gateway_message_skipped",
      metadata: {
        eventId: envelope.id,
        reason: "sender_identity_missing",
      } as unknown as Json,
    });
    return;
  }

  const senderName = envelope.data.actor.display_name || senderId;
  const senderUsername = metadataString(metadata, "username");
  const senderPicture = metadataString(metadata, "picture") ?? metadataString(metadata, "avatar_url");
  const contact = await upsertContactForSender({
    supabase,
    channel,
    senderId,
    senderName,
    senderPicture,
    senderUsername,
    interactionAt: envelope.occurred_at,
  });
  if (!contact) throw new Error("failed to project Social Gateway contact");

  const { data: existingConversation, error: conversationReadError } = await supabase
    .from("conversations")
    .select("id, is_automation_paused")
    .eq("channel_id", channel.id)
    .eq("contact_id", contact.contactId)
    .maybeSingle();
  if (conversationReadError) throw new Error(conversationReadError.message);

  const preview = messagePreview(envelope);
  let conversationId: string;
  let automationPaused: boolean;

  if (existingConversation) {
    const { error: projectionError } = await supabase.rpc(
      "apply_social_gateway_inbound_conversation",
      {
        p_conversation_id: existingConversation.id,
        p_occurred_at: envelope.occurred_at,
        p_preview: preview,
        p_gateway_conversation_id: envelope.conversation_id,
      },
    );
    if (projectionError) throw new Error(projectionError.message);
    conversationId = existingConversation.id;
    automationPaused = existingConversation.is_automation_paused;
  } else {
    const { data: createdConversation, error: conversationCreateError } = await supabase
      .from("conversations")
      .insert({
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        contact_id: contact.contactId,
        platform: channel.platform,
        late_conversation_id: envelope.conversation_id,
        status: "open",
        last_message_at: envelope.occurred_at,
        last_message_preview: preview,
        unread_count: 1,
      })
      .select("id, is_automation_paused")
      .single();
    if (conversationCreateError || !createdConversation) {
      throw new Error(conversationCreateError?.message ?? "failed to project conversation");
    }
    conversationId = createdConversation.id;
    automationPaused = createdConversation.is_automation_paused;
  }

  if (automationPaused) return;

  const incomingMessage = {
    text: envelope.data.content.text ?? undefined,
    postbackPayload: metadataString(metadata, "postback_payload") ?? undefined,
    quickReplyPayload: metadataString(metadata, "quick_reply_payload") ?? undefined,
    callbackData: metadataString(metadata, "callback_data") ?? undefined,
    sender: {
      id: senderId,
      name: envelope.data.actor.display_name ?? undefined,
      username: senderUsername ?? undefined,
    },
  };

  const handledByGlobalKeyword = await handleGlobalKeywords(
    supabase,
    channel.workspace_id,
    contact.contactId,
    envelope.data.content.text ?? undefined,
  );
  if (handledByGlobalKeyword) return;

  const trigger = await matchTrigger(supabase, {
    channelId: channel.id,
    workspaceId: channel.workspace_id,
    conversationId,
    message: incomingMessage,
    isFirstMessage: !contact.existed,
  });
  if (!trigger) return;

  await executeFlow(supabase, {
    triggerId: trigger.id,
    flowId: trigger.flow_id,
    channelId: channel.id,
    contactId: contact.contactId,
    conversationId,
    workspaceId: channel.workspace_id,
    incomingMessage,
    lateConversationId: envelope.conversation_id ?? undefined,
    lateAccountId: envelope.provider_account_id,
    variables: {
      gateway_event_id: envelope.id,
      gateway_message_id: envelope.message_id ?? "",
    },
  });
}

async function processGatewayComment(
  supabase: SupabaseClient<Database>,
  channel: Channel,
  envelope: SocialGatewayWebhookEnvelope,
): Promise<void> {
  const commentId = envelope.data.external_message_ref;
  const postId = envelope.data.external_conversation_ref;
  if (!commentId || !postId) {
    throw new Error("comment event is missing its provider comment or post reference");
  }

  const result = await processComment({
    supabase,
    channel,
    gatewayConversationId: envelope.conversation_id ?? undefined,
    comment: {
      id: commentId,
      postId,
      text: envelope.data.content.text ?? "",
      author: {
        id: envelope.data.actor.external_id ?? undefined,
        name: envelope.data.actor.display_name ?? undefined,
        username: metadataString(envelope.data.metadata, "username") ?? undefined,
      },
    },
  });
  if (result.error) throw new Error(result.error);
}

async function handleGlobalKeywords(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  contactId: string,
  text: string | undefined,
): Promise<boolean> {
  if (!text) return false;

  const { data: workspace, error } = await supabase
    .from("workspaces")
    .select("global_keywords")
    .eq("id", workspaceId)
    .single();
  if (error) throw new Error(error.message);
  if (!workspace?.global_keywords) return false;

  const keywords = workspace.global_keywords as unknown as Array<{
    keyword: string;
    action?: string;
    flowId?: string;
  }>;
  const normalizedText = text.toLowerCase().trim();

  for (const keyword of keywords) {
    if (normalizedText !== keyword.keyword.toLowerCase()) continue;
    if (keyword.action === "unsubscribe") {
      const { error: updateError } = await supabase
        .from("contacts")
        .update({ is_subscribed: false })
        .eq("id", contactId);
      if (updateError) throw new Error(updateError.message);
      return true;
    }
    if (keyword.action === "subscribe") {
      const { error: updateError } = await supabase
        .from("contacts")
        .update({ is_subscribed: true })
        .eq("id", contactId);
      if (updateError) throw new Error(updateError.message);
      return true;
    }
    return false;
  }

  return false;
}

import { NextResponse } from "next/server";
import {
  planGatewayConversationSync,
  type ConversationProjectionChannel,
  type ExistingContactChannelProjection,
  type ExistingConversationProjection,
} from "@/lib/social-gateway/conversation-sync";
import {
  SocialGatewayConfigurationError,
  SocialGatewayError,
} from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import { getWorkspace } from "@/lib/workspace";

const SYNC_LIMIT = 100;

function gatewayFailure(error: unknown): NextResponse {
  if (error instanceof SocialGatewayConfigurationError) {
    return NextResponse.json(
      { code: error.code, error: error.message },
      { status: 503 },
    );
  }
  if (error instanceof SocialGatewayError) {
    return NextResponse.json(
      { code: error.code, error: error.message, retryable: error.retryable },
      { status: error.status && error.status >= 400 ? error.status : 502 },
    );
  }
  console.error("[conversations/sync] unexpected failure", {
    errorType: error instanceof Error ? error.name : typeof error,
  });
  return NextResponse.json(
    { code: "conversation_sync_failed", error: "Conversation synchronization failed" },
    { status: 500 },
  );
}

/**
 * POST /api/v1/conversations/sync
 *
 * Projects gateway conversation summaries, participants and contact identities
 * into ZernFlow. Message bodies remain authoritative in Agent Social Gateway
 * and are fetched on demand through /api/v1/messages.
 */
export async function POST() {
  const { workspace, role, supabase } = await getWorkspace();
  if (role !== "owner") {
    return NextResponse.json(
      { code: "workspace_owner_required", error: "Workspace owner access required" },
      { status: 403 },
    );
  }

  try {
    const gateway = requireSocialGatewayClient();
    const [page, channelsResult, conversationsResult, contactChannelsResult] =
      await Promise.all([
        gateway.listConversations({ limit: SYNC_LIMIT }),
        supabase
          .from("channels")
          .select("id, late_account_id, platform")
          .eq("workspace_id", workspace.id)
          .eq("is_active", true),
        supabase
          .from("conversations")
          .select(
            "id, late_conversation_id, channel_id, contact_id, last_message_at, last_message_preview",
          )
          .eq("workspace_id", workspace.id)
          .not("late_conversation_id", "is", null),
        supabase
          .from("contact_channels")
          .select("channel_id, platform_sender_id, contact_id")
          .in(
            "channel_id",
            (
              await supabase
                .from("channels")
                .select("id")
                .eq("workspace_id", workspace.id)
            ).data?.map((channel) => channel.id) ?? [],
          ),
      ]);

    if (channelsResult.error) throw new Error(channelsResult.error.message);
    if (conversationsResult.error) throw new Error(conversationsResult.error.message);
    if (contactChannelsResult.error) throw new Error(contactChannelsResult.error.message);

    const details = await Promise.all(
      page.items.map(async (summary) => ({
        summary,
        detail: await gateway.getConversation(summary.id, { messageLimit: 1 }),
      })),
    );

    const plan = planGatewayConversationSync(
      details,
      (channelsResult.data ?? []).map((channel) => ({
        id: channel.id,
        gatewayAccountId: channel.late_account_id,
        platform: channel.platform,
      })) as ConversationProjectionChannel[],
      (conversationsResult.data ?? []).map((conversation) => ({
        id: conversation.id,
        gatewayConversationId: conversation.late_conversation_id ?? "",
        channelId: conversation.channel_id,
        contactId: conversation.contact_id,
        lastMessageAt: conversation.last_message_at,
        lastMessagePreview: conversation.last_message_preview,
      })) as ExistingConversationProjection[],
      (contactChannelsResult.data ?? []).map((contactChannel) => ({
        channelId: contactChannel.channel_id,
        platformSenderId: contactChannel.platform_sender_id,
        contactId: contactChannel.contact_id,
      })) as ExistingContactChannelProjection[],
    );

    for (const update of plan.updates) {
      const { error } = await supabase
        .from("conversations")
        .update({
          last_message_at: update.lastMessageAt,
          last_message_preview: update.lastMessagePreview,
        })
        .eq("id", update.conversationId)
        .eq("workspace_id", workspace.id);
      if (error) throw new Error(error.message);
    }

    let created = 0;
    for (const item of plan.creates) {
      let contactId = item.existingContactId;
      if (!contactId) {
        const { data: contact, error: contactError } = await supabase
          .from("contacts")
          .insert({
            workspace_id: workspace.id,
            display_name: item.participant.display_name,
            last_interaction_at: item.lastMessageAt,
            metadata: {
              gateway_participant_id: item.participant.id,
              gateway_participant_ref: item.participant.external_participant_ref,
              ...item.participant.metadata,
            },
          })
          .select("id")
          .single();
        if (contactError || !contact) {
          throw new Error(contactError?.message ?? "Failed to create contact");
        }
        contactId = contact.id;

        const { error: contactChannelError } = await supabase
          .from("contact_channels")
          .insert({
            contact_id: contactId,
            channel_id: item.channelId,
            platform_sender_id: item.participant.external_participant_ref,
            platform_username: item.participant.display_name,
          });
        if (contactChannelError) throw new Error(contactChannelError.message);
      }

      const { error: conversationError } = await supabase.from("conversations").insert({
        workspace_id: workspace.id,
        channel_id: item.channelId,
        contact_id: contactId,
        late_conversation_id: item.gatewayConversationId,
        platform: item.platform,
        last_message_at: item.lastMessageAt,
        last_message_preview: item.lastMessagePreview,
        unread_count: 0,
      });
      if (conversationError) throw new Error(conversationError.message);
      created += 1;
    }

    return NextResponse.json({
      source: "agent-social-gateway",
      synchronized: {
        created,
        updated: plan.updates.length,
        unchanged: plan.unchangedConversationIds.length,
        skipped: plan.skipped,
      },
      next_cursor: page.next_cursor,
      truncated: page.next_cursor !== null,
    });
  } catch (error) {
    return gatewayFailure(error);
  }
}

import type {
  GatewayConversationDetail,
  GatewayConversationSummary,
  GatewayParticipant,
} from "./types";

export interface ConversationProjectionChannel {
  id: string;
  gatewayAccountId: string;
  platform: string;
}

export interface ExistingConversationProjection {
  id: string;
  gatewayConversationId: string;
  channelId: string;
  contactId: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export interface ExistingContactChannelProjection {
  channelId: string;
  platformSenderId: string;
  contactId: string;
}

export interface ConversationProjectionInput {
  summary: GatewayConversationSummary;
  detail: GatewayConversationDetail;
}

export interface ConversationCreatePlan {
  gatewayConversationId: string;
  channelId: string;
  platform: string;
  participant: GatewayParticipant;
  existingContactId: string | null;
  lastMessageAt: string;
  lastMessagePreview: string | null;
}

export interface ConversationUpdatePlan {
  conversationId: string;
  lastMessageAt: string;
  lastMessagePreview: string | null;
}

export interface SkippedConversationProjection {
  gatewayConversationId: string;
  reason: "channel_not_projected" | "participant_not_available";
}

export interface ConversationSyncPlan {
  creates: ConversationCreatePlan[];
  updates: ConversationUpdatePlan[];
  unchangedConversationIds: string[];
  skipped: SkippedConversationProjection[];
}

function contactKey(channelId: string, participantRef: string): string {
  return `${channelId}\u0000${participantRef}`;
}

function selectExternalParticipant(
  participants: GatewayParticipant[],
): GatewayParticipant | null {
  return participants.find((participant) => participant.external_participant_ref.trim()) ?? null;
}

export function planGatewayConversationSync(
  inputs: ConversationProjectionInput[],
  channels: ConversationProjectionChannel[],
  existingConversations: ExistingConversationProjection[],
  existingContactChannels: ExistingContactChannelProjection[],
): ConversationSyncPlan {
  const channelByGatewayAccountId = new Map(
    channels.map((channel) => [channel.gatewayAccountId, channel]),
  );
  const existingByGatewayConversationId = new Map(
    existingConversations.map((conversation) => [
      conversation.gatewayConversationId,
      conversation,
    ]),
  );
  const contactIdByChannelAndParticipant = new Map(
    existingContactChannels.map((contactChannel) => [
      contactKey(contactChannel.channelId, contactChannel.platformSenderId),
      contactChannel.contactId,
    ]),
  );

  const creates: ConversationCreatePlan[] = [];
  const updates: ConversationUpdatePlan[] = [];
  const unchangedConversationIds: string[] = [];
  const skipped: SkippedConversationProjection[] = [];

  for (const input of inputs) {
    const { summary, detail } = input;
    const channel = channelByGatewayAccountId.get(summary.provider_account_ref);
    if (!channel) {
      skipped.push({
        gatewayConversationId: summary.id,
        reason: "channel_not_projected",
      });
      continue;
    }

    const existing = existingByGatewayConversationId.get(summary.id);
    if (existing) {
      if (
        existing.lastMessageAt !== summary.last_message_at ||
        existing.lastMessagePreview !== summary.latest_message_text
      ) {
        updates.push({
          conversationId: existing.id,
          lastMessageAt: summary.last_message_at,
          lastMessagePreview: summary.latest_message_text,
        });
      } else {
        unchangedConversationIds.push(existing.id);
      }
      continue;
    }

    const participant = selectExternalParticipant(detail.participants);
    if (!participant) {
      skipped.push({
        gatewayConversationId: summary.id,
        reason: "participant_not_available",
      });
      continue;
    }

    creates.push({
      gatewayConversationId: summary.id,
      channelId: channel.id,
      platform: channel.platform,
      participant,
      existingContactId:
        contactIdByChannelAndParticipant.get(
          contactKey(channel.id, participant.external_participant_ref),
        ) ?? null,
      lastMessageAt: summary.last_message_at,
      lastMessagePreview: summary.latest_message_text,
    });
  }

  return { creates, updates, unchangedConversationIds, skipped };
}

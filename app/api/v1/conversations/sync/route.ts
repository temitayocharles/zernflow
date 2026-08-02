import { NextRequest, NextResponse } from "next/server";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  planGatewayConversationSync,
  type ConversationCreatePlan,
  type ConversationProjectionChannel,
  type ExistingContactChannelProjection,
  type ExistingConversationProjection,
} from "@/lib/social-gateway/conversation-sync";
import {
  SocialGatewayConfigurationError,
  SocialGatewayError,
} from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import type {
  GatewayConversationDetail,
  GatewayConversationSummary,
} from "@/lib/social-gateway/types";
import { getWorkspace } from "@/lib/workspace";

const DEFAULT_SYNC_LIMIT = 50;
const MAX_SYNC_LIMIT = 100;
const DETAIL_CONCURRENCY = 5;
const WRITE_CONCURRENCY = 5;
const MAX_CURSOR_LENGTH = 4096;

type WorkspaceSupabase = Awaited<ReturnType<typeof getWorkspace>>["supabase"];

class ConversationSyncInputError extends Error {}

function parseSyncInput(request: NextRequest): { limit: number; cursor?: string } {
  const rawLimit = request.nextUrl.searchParams.get("limit");
  const rawCursor = request.nextUrl.searchParams.get("cursor")?.trim();
  const limit = rawLimit === null ? DEFAULT_SYNC_LIMIT : Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SYNC_LIMIT) {
    throw new ConversationSyncInputError(
      `limit must be an integer between 1 and ${MAX_SYNC_LIMIT}`,
    );
  }
  if (rawCursor && rawCursor.length > MAX_CURSOR_LENGTH) {
    throw new ConversationSyncInputError("cursor is too long");
  }

  return rawCursor ? { limit, cursor: rawCursor } : { limit };
}

function gatewayFailure(error: unknown): NextResponse {
  if (error instanceof ConversationSyncInputError) {
    return NextResponse.json(
      { code: "invalid_sync_input", error: error.message },
      { status: 400 },
    );
  }
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
    {
      code: "conversation_sync_failed",
      error: "Conversation synchronization failed",
    },
    { status: 500 },
  );
}

function emptyDetail(summary: GatewayConversationSummary): GatewayConversationDetail {
  return {
    conversation: summary,
    participants: [],
    messages: [],
    next_message_cursor: null,
  };
}

function metadataText(
  metadata: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function resolveContactId(
  supabase: WorkspaceSupabase,
  workspaceId: string,
  item: ConversationCreatePlan,
): Promise<string> {
  if (item.existingContactId) {
    const { error } = await supabase
      .from("contacts")
      .update({ last_interaction_at: item.lastMessageAt })
      .eq("id", item.existingContactId)
      .eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    return item.existingContactId;
  }

  const { data: existingRelation, error: existingRelationError } = await supabase
    .from("contact_channels")
    .select("contact_id")
    .eq("channel_id", item.channelId)
    .eq("platform_sender_id", item.participant.external_participant_ref)
    .maybeSingle();
  if (existingRelationError) throw new Error(existingRelationError.message);
  if (existingRelation) return existingRelation.contact_id;

  const username = metadataText(item.participant.metadata, [
    "username",
    "handle",
    "platform_username",
  ]);
  const avatarUrl = metadataText(item.participant.metadata, [
    "avatar_url",
    "picture",
    "profile_picture",
  ]);
  const displayName =
    item.participant.display_name ??
    username ??
    item.participant.external_participant_ref;

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      workspace_id: workspaceId,
      display_name: displayName,
      avatar_url: avatarUrl,
      last_interaction_at: item.lastMessageAt,
      metadata: {
        ...item.participant.metadata,
        gateway_participant_id: item.participant.id,
        gateway_participant_ref: item.participant.external_participant_ref,
      },
    })
    .select("id")
    .single();
  if (contactError || !contact) {
    throw new Error(contactError?.message ?? "Failed to create contact");
  }

  const { error: relationError } = await supabase.from("contact_channels").insert({
    contact_id: contact.id,
    channel_id: item.channelId,
    platform_sender_id: item.participant.external_participant_ref,
    platform_username: username,
  });

  if (!relationError) return contact.id;

  await supabase
    .from("contacts")
    .delete()
    .eq("id", contact.id)
    .eq("workspace_id", workspaceId);

  if (relationError.code !== "23505") throw new Error(relationError.message);

  const { data: racedRelation, error: racedRelationError } = await supabase
    .from("contact_channels")
    .select("contact_id")
    .eq("channel_id", item.channelId)
    .eq("platform_sender_id", item.participant.external_participant_ref)
    .single();
  if (racedRelationError || !racedRelation) {
    throw new Error(
      racedRelationError?.message ?? "Failed to resolve concurrent contact projection",
    );
  }
  return racedRelation.contact_id;
}

/**
 * POST /api/v1/conversations/sync?limit=50&cursor=...
 *
 * Projects gateway conversation summaries, participants and contact identities
 * into ZernFlow. Message bodies remain authoritative in Agent Social Gateway
 * and are fetched on demand through /api/v1/messages.
 */
export async function POST(request: NextRequest) {
  const { workspace, role, supabase } = await getWorkspace();
  if (role !== "owner") {
    return NextResponse.json(
      {
        code: "workspace_owner_required",
        error: "Workspace owner access required",
      },
      { status: 403 },
    );
  }

  try {
    const input = parseSyncInput(request);
    const gateway = requireSocialGatewayClient();

    const channelsResult = await supabase
      .from("channels")
      .select("id, late_account_id, platform")
      .eq("workspace_id", workspace.id)
      .eq("is_active", true);
    if (channelsResult.error) throw new Error(channelsResult.error.message);

    const channelRows = channelsResult.data ?? [];
    const channelIds = channelRows.map((channel) => channel.id);
    const projectedAccountIds = new Set(
      channelRows.map((channel) => channel.late_account_id),
    );

    const [page, conversationsResult, contactChannelsResult] = await Promise.all([
      gateway.listConversations(input),
      supabase
        .from("conversations")
        .select(
          "id, late_conversation_id, channel_id, contact_id, last_message_at, last_message_preview",
        )
        .eq("workspace_id", workspace.id)
        .not("late_conversation_id", "is", null),
      channelIds.length > 0
        ? supabase
            .from("contact_channels")
            .select("channel_id, platform_sender_id, contact_id")
            .in("channel_id", channelIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (conversationsResult.error) throw new Error(conversationsResult.error.message);
    if (contactChannelsResult.error) throw new Error(contactChannelsResult.error.message);

    const existingConversationIds = new Set(
      (conversationsResult.data ?? []).map(
        (conversation) => conversation.late_conversation_id,
      ),
    );
    const detailCandidates = page.items.filter(
      (summary) =>
        projectedAccountIds.has(summary.provider_account_ref) &&
        !existingConversationIds.has(summary.id),
    );
    const fetchedDetails = await mapWithConcurrency(
      detailCandidates,
      DETAIL_CONCURRENCY,
      (summary) => gateway.getConversation(summary.id, { messageLimit: 1 }),
    );
    const detailByConversationId = new Map(
      fetchedDetails.map((detail) => [detail.conversation.id, detail]),
    );

    const plan = planGatewayConversationSync(
      page.items.map((summary) => ({
        summary,
        detail: detailByConversationId.get(summary.id) ?? emptyDetail(summary),
      })),
      channelRows.map((channel) => ({
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

    await mapWithConcurrency(plan.updates, WRITE_CONCURRENCY, async (update) => {
      const { error } = await supabase
        .from("conversations")
        .update({
          last_message_at: update.lastMessageAt,
          last_message_preview: update.lastMessagePreview,
        })
        .eq("id", update.conversationId)
        .eq("workspace_id", workspace.id);
      if (error) throw new Error(error.message);
    });

    await mapWithConcurrency(plan.creates, WRITE_CONCURRENCY, async (item) => {
      const contactId = await resolveContactId(
        supabase,
        workspace.id,
        item,
      );
      const { error } = await supabase.from("conversations").upsert(
        {
          workspace_id: workspace.id,
          channel_id: item.channelId,
          contact_id: contactId,
          late_conversation_id: item.gatewayConversationId,
          platform: item.platform,
          status: "open",
          last_message_at: item.lastMessageAt,
          last_message_preview: item.lastMessagePreview,
          unread_count: 0,
        },
        { onConflict: "workspace_id,late_conversation_id" },
      );
      if (error) throw new Error(error.message);
    });

    return NextResponse.json({
      source: "agent-social-gateway",
      page: {
        requested_limit: input.limit,
        received: page.items.length,
        detail_requests: detailCandidates.length,
        next_cursor: page.next_cursor,
        truncated: page.next_cursor !== null,
      },
      synchronized: {
        projected: plan.creates.length,
        updated: plan.updates.length,
        unchanged: plan.unchangedConversationIds.length,
        skipped: plan.skipped,
      },
    });
  } catch (error) {
    return gatewayFailure(error);
  }
}

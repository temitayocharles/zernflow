import { NextResponse } from "next/server";
import {
  planGatewayChannelSync,
  type ExistingChannel,
} from "@/lib/social-gateway/channel-sync";
import {
  SocialGatewayConfigurationError,
  SocialGatewayError,
} from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import { getWorkspace } from "@/lib/workspace";
import { synchronizeAgentDraftGrants } from "@/lib/social-gateway/agent-grant-sync";

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
      { status: error.retryable ? 503 : 502 },
    );
  }
  console.error("[channels/sync] unexpected failure", {
    errorType: error instanceof Error ? error.name : typeof error,
  });
  return NextResponse.json(
    { code: "channel_sync_failed", error: "Channel synchronization failed" },
    { status: 500 },
  );
}

/**
 * POST /api/v1/channels/sync
 *
 * Projects connected Agent Social Gateway accounts into ZernFlow's local
 * channel table. The gateway remains the provider-account source of truth;
 * this table is a UI/automation projection only.
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
    const [{ accounts }, existingResult] = await Promise.all([
      gateway.listAccounts(),
      supabase
        .from("channels")
        .select(
          "id, late_account_id, platform, username, display_name, profile_picture, is_active",
        )
        .eq("workspace_id", workspace.id),
    ]);

    const agentDrafts = await synchronizeAgentDraftGrants(
      accounts.map((account) => account._id),
    );

    if (existingResult.error) {
      throw new Error(`Failed to read local channels: ${existingResult.error.message}`);
    }

    // `late_account_id` is retained temporarily as the database column name,
    // but values written by this path are Agent Social Gateway account IDs.
    const plan = planGatewayChannelSync(
      accounts,
      (existingResult.data ?? []) as ExistingChannel[],
    );

    if (plan.creates.length > 0) {
      const { error } = await supabase.from("channels").insert(
        plan.creates.map((item) => ({
          workspace_id: workspace.id,
          platform: item.platform,
          late_account_id: item.gatewayAccountId,
          username: item.username,
          display_name: item.displayName,
          profile_picture: item.profilePicture,
          is_active: item.isActive,
        })),
      );
      if (error) throw new Error(`Failed to create channels: ${error.message}`);
    }

    for (const item of plan.updates) {
      const { error } = await supabase
        .from("channels")
        .update({
          platform: item.platform,
          username: item.username,
          display_name: item.displayName,
          profile_picture: item.profilePicture,
          is_active: item.isActive,
        })
        .eq("id", item.channelId)
        .eq("workspace_id", workspace.id);
      if (error) throw new Error(`Failed to update channel: ${error.message}`);
    }

    if (plan.deactivateChannelIds.length > 0) {
      const { error } = await supabase
        .from("channels")
        .update({ is_active: false })
        .eq("workspace_id", workspace.id)
        .in("id", plan.deactivateChannelIds);
      if (error) throw new Error(`Failed to deactivate channels: ${error.message}`);
    }

    const { data: channels, error: channelListError } = await supabase
      .from("channels")
      .select("*")
      .eq("workspace_id", workspace.id)
      .order("created_at", { ascending: false });
    if (channelListError) {
      throw new Error(`Failed to list synchronized channels: ${channelListError.message}`);
    }

    return NextResponse.json({
      source: "agent-social-gateway",
      channels: channels ?? [],
      capabilities: { agentDrafts },
      synced: {
        created: plan.creates.length,
        updated: plan.updates.length,
        deactivated: plan.deactivateChannelIds.length,
        unsupported: plan.unsupported,
      },
    });
  } catch (error) {
    return gatewayFailure(error);
  }
}

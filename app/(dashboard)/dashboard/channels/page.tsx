import { getSocialGatewayClient } from "@/lib/social-gateway/server";
import { CONNECTORS, canStartOnboarding } from "@/lib/connectors/registry";
import type { Platform } from "@/lib/types/database";
import { CHANNEL_SAFE_COLUMNS, getWorkspace } from "@/lib/workspace";
import { ChannelsView } from "./channels-view";
import { ManualChannelForm } from "@/components/campaigns/manual-channel-form";

export default async function ChannelsPage() {
  const { workspace, supabase, role } = await getWorkspace();

  const { data: channels } = await supabase
    .from("channels")
    .select(CHANNEL_SAFE_COLUMNS)
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });

  let onboardingPlatforms: Platform[] = [];
  let readinessUnavailable = false;
  try {
    const gateway = getSocialGatewayClient();
    const readiness = gateway ? await gateway.getProviderReadiness("meta") : null;
    readinessUnavailable = !gateway;
    onboardingPlatforms = CONNECTORS.filter((connector) =>
      canStartOnboarding(connector.id, readiness),
    ).map((connector) => connector.id);
  } catch {
    // The Channels page remains available when the external Gateway is unavailable.
    onboardingPlatforms = [];
    readinessUnavailable = true;
  }

  return (
    <>
    <ChannelsView
      key={(channels ?? []).map((c) => c.id).join(",")}
      channels={channels ?? []}
      workspaceId={workspace.id}
      onboardingPlatforms={onboardingPlatforms}
      canManage={role === "owner"}
      readinessUnavailable={readinessUnavailable}
    />
    {role === "owner" && <div className="px-6 pb-6"><ManualChannelForm /></div>}
    </>
  );
}

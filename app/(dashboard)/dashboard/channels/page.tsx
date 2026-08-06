import { getSocialGatewayClient } from "@/lib/social-gateway/server";
import type { GatewayAccountPlatform } from "@/lib/social-gateway/types";
import { getWorkspace } from "@/lib/workspace";
import { ChannelsView } from "./channels-view";

const supportedPlatforms = new Set<GatewayAccountPlatform>(["facebook", "instagram"]);

export default async function ChannelsPage() {
  const { workspace, role, supabase } = await getWorkspace();
  const { data: channels } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });
  let onboardingPlatforms: GatewayAccountPlatform[] = [];
  if (role === "owner") {
    try {
      const gateway = getSocialGatewayClient();
      if (gateway) {
        const readiness = await gateway.getProviderReadiness();
        if (readiness.configured) {
          onboardingPlatforms = readiness.platforms.filter((platform) =>
            supportedPlatforms.has(platform),
          );
        }
      }
    } catch {
      onboardingPlatforms = [];
    }
  }
  return (
    <ChannelsView
      channels={channels ?? []}
      workspaceId={workspace.id}
      onboardingPlatforms={onboardingPlatforms}
    />
  );
}

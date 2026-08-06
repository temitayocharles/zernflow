import { getSocialGatewayClient } from "@/lib/social-gateway/server";
import type { Platform } from "@/lib/types/database";
import { getWorkspace } from "@/lib/workspace";
import { ChannelsView } from "./channels-view";

const supportedPlatforms = new Set<Platform>(["facebook", "instagram"]);

export default async function ChannelsPage() {
  const { workspace, role, supabase } = await getWorkspace();
  const { data: channels } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });
  let onboardingPlatforms: Platform[] = [];
  if (role === "owner") {
    try {
      const gateway = getSocialGatewayClient();
      if (gateway) {
        const readiness = await gateway.getProviderReadiness();
        if (readiness.configured) {
          onboardingPlatforms = readiness.platforms.filter(
            (platform): platform is Platform =>
              supportedPlatforms.has(platform as Platform),
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

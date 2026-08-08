import { getSocialGatewayClient } from "@/lib/social-gateway/server";
import type { Platform } from "@/lib/types/database";
import { getWorkspace } from "@/lib/workspace";
import { ChannelsView } from "./channels-view";

export default async function ChannelsPage() {
  const { workspace, supabase } = await getWorkspace();

  const { data: channels } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });

  let onboardingPlatforms: Platform[] = [];
  try {
    const gateway = getSocialGatewayClient();
    const readiness = gateway ? await gateway.getProviderReadiness("meta") : null;
    if (readiness?.configured) {
      onboardingPlatforms = [
        ...(readiness.platforms.includes("facebook") ? (["facebook"] as Platform[]) : []),
        ...(readiness.platforms.includes("instagram") ? (["instagram"] as Platform[]) : []),
      ];
    }
  } catch {
    // The Channels page remains available when the external Gateway is unavailable.
    onboardingPlatforms = [];
  }

  return (
    <ChannelsView
      channels={channels ?? []}
      workspaceId={workspace.id}
      onboardingPlatforms={onboardingPlatforms}
    />
  );
}

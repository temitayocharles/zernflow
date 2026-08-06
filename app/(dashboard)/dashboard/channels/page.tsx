import { getSocialGatewayClient } from "@/lib/social-gateway/server";
import { getWorkspace } from "@/lib/workspace";
import { ChannelsView } from "./channels-view";

export default async function ChannelsPage() {
  const { workspace, supabase } = await getWorkspace();

  const { data: channels } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });

  let providerOnboardingEnabled = false;
  try {
    const gateway = getSocialGatewayClient();
    const readiness = gateway ? await gateway.getProviderReadiness("meta") : null;
    providerOnboardingEnabled = Boolean(
      readiness?.configured &&
        readiness.platforms.some(
          (platform) => platform === "facebook" || platform === "instagram",
        ),
    );
  } catch {
    // The Channels page remains available when the external Gateway is unavailable.
    providerOnboardingEnabled = false;
  }

  return (
    <ChannelsView
      channels={channels ?? []}
      workspaceId={workspace.id}
      providerOnboardingEnabled={providerOnboardingEnabled}
    />
  );
}

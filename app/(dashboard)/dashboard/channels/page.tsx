import { getWorkspace } from "@/lib/workspace";
import { ChannelsView } from "./channels-view";

export default async function ChannelsPage() {
  const { workspace, supabase } = await getWorkspace();

  const { data: channels } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });

  const providerOnboardingEnabled =
    process.env.SOCIAL_GATEWAY_PROVIDER_ONBOARDING_ENABLED === "true";

  return (
    <ChannelsView
      channels={channels ?? []}
      workspaceId={workspace.id}
      providerOnboardingEnabled={providerOnboardingEnabled}
    />
  );
}

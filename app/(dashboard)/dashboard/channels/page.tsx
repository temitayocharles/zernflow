import { getWorkspace } from "@/lib/workspace";
import { ChannelsView } from "./channels-view";

export default async function ChannelsPage() {
  const { workspace, supabase } = await getWorkspace();

  const { data: channels } = await supabase
    .from("channels")
    .select("*")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });

  // The Gateway currently creates administrator provisioning sessions, not a
  // complete customer OAuth/token-exchange flow. Keep self-service onboarding
  // disabled until the callback adapter can store provider credentials in Vault
  // and complete the connection with a Vault reference.
  const providerOnboardingEnabled = false;

  return (
    <ChannelsView
      channels={channels ?? []}
      workspaceId={workspace.id}
      providerOnboardingEnabled={providerOnboardingEnabled}
    />
  );
}

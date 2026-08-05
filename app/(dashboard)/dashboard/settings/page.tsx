import { isSocialGatewayConfigured } from "@/lib/social-gateway/server";
import { getWorkspace } from "@/lib/workspace";
import { SettingsView } from "./settings-view";

export default async function SettingsPage() {
  const { workspace, role } = await getWorkspace();

  return (
    <SettingsView
      workspace={{
        id: workspace.id,
        name: workspace.name,
        globalKeywords: (workspace.global_keywords as string[]) ?? [],
        canManageSettings: role === "owner",
        gatewayConfigured: isSocialGatewayConfigured(),
        aiConfigured: Boolean(process.env.AI_GATEWAY_API_KEY?.trim()),
      }}
    />
  );
}

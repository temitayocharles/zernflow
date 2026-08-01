import { getWorkspace } from "@/lib/workspace";
import { getSocialGatewayRuntimeStatus } from "@/lib/social-gateway/client";
import { SettingsView } from "./settings-view";

export default async function SettingsPage() {
  const { workspace } = await getWorkspace();
  const gateway = getSocialGatewayRuntimeStatus();

  return (
    <SettingsView
      workspace={{
        id: workspace.id,
        name: workspace.name,
        gatewayDriver: gateway.driver,
        gatewayConfigured: gateway.configured,
        aiConfigured: Boolean(process.env.AI_GATEWAY_API_KEY?.trim()),
        globalKeywords: (workspace.global_keywords as string[]) ?? [],
      }}
    />
  );
}

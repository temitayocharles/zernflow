import type { Platform } from "@/lib/types/database";
import type { GatewayAccount, GatewayProviderReadiness } from "@/lib/social-gateway/types";

export type ConnectionType = "oauth" | "token" | "webhook" | "browser_session" | "external";
export type ConnectorState = "available" | "configured" | "connected" | "degraded" | "unavailable" | "coming_later";
export type BrowserSessionState = "human_login_required" | "mfa_required" | "expired" | "healthy" | "degraded";

export interface ConnectorDefinition {
  id: Platform;
  label: string;
  connectionType: ConnectionType;
  /** Only routes with an implemented ZernFlow/Gateway contract belong here. */
  onboarding: "meta_oauth" | "gateway_managed";
  setupHelp: string;
}

export const CONNECTORS: readonly ConnectorDefinition[] = [
  { id: "instagram", label: "Instagram", connectionType: "oauth", onboarding: "meta_oauth", setupHelp: "Connect an eligible Instagram account through the configured Meta application." },
  { id: "facebook", label: "Facebook", connectionType: "oauth", onboarding: "meta_oauth", setupHelp: "Connect a Facebook Page through the configured Meta application." },
  { id: "telegram", label: "Telegram", connectionType: "token", onboarding: "gateway_managed", setupHelp: "Configure the bot in Agent Social Gateway, then use Sync to import it. Never enter a bot token here." },
  { id: "twitter", label: "X / Twitter", connectionType: "external", onboarding: "gateway_managed", setupHelp: "Import an existing Gateway account with Sync. Availability depends on its configured connector." },
  { id: "bluesky", label: "Bluesky", connectionType: "external", onboarding: "gateway_managed", setupHelp: "Import an existing Gateway account with Sync. Availability depends on its configured connector." },
  { id: "reddit", label: "Reddit", connectionType: "external", onboarding: "gateway_managed", setupHelp: "Import an existing Gateway account with Sync. Availability depends on its configured connector." },
  { id: "whatsapp", label: "WhatsApp", connectionType: "external", onboarding: "gateway_managed", setupHelp: "Import an existing Gateway account with Sync. Availability depends on its configured connector." },
];

export function getConnector(value: string): ConnectorDefinition | undefined {
  return CONNECTORS.find((connector) => connector.id === value);
}

export function isProjectionPlatform(value: string): value is Platform {
  return getConnector(value) !== undefined;
}

export function isOAuthPlatform(value: unknown): value is "facebook" | "instagram" {
  return typeof value === "string" && getConnector(value)?.onboarding === "meta_oauth";
}

export function canStartOnboarding(platform: string, readiness: GatewayProviderReadiness | null): boolean {
  return isOAuthPlatform(platform) && readiness?.provider === "meta" &&
    readiness.configured === true && readiness.platforms.includes(platform);
}

/** Use only a workspace-authorized account. Never derive live health from a local is_active flag. */
export function resolveConnectorState(input: {
  platform: string;
  gatewayReachable: boolean;
  readiness?: GatewayProviderReadiness | null;
  account?: Pick<GatewayAccount, "status" | "platform"> | null;
}): ConnectorState {
  if (!getConnector(input.platform)) return "coming_later";
  if (!input.gatewayReachable) return "unavailable";
  if (input.account?.platform === input.platform) {
    switch (input.account.status) {
      case "active": return "connected";
      case "degraded": case "error": return "degraded";
      case "pending": return "configured";
      case "disconnected": return "unavailable";
    }
  }
  return canStartOnboarding(input.platform, input.readiness ?? null) ? "available" : "unavailable";
}

/** Unknown/missing capabilities fail closed; metadata is not a grant. */
export function hasCapability(account: Pick<GatewayAccount, "status" | "capabilities">, capability: string): boolean {
  return account.status === "active" && Object.hasOwn(account.capabilities, capability) && account.capabilities[capability] === true;
}

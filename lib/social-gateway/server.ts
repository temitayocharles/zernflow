import "server-only";

import {
  HttpSocialGatewayClient,
  SocialGatewayConfigurationError,
} from "./client";
import type { SocialGatewayClient } from "./types";

let cachedClient: SocialGatewayClient | null | undefined;

function parseTimeout(rawValue: string | undefined): number {
  if (!rawValue) return 10_000;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 60_000) {
    throw new SocialGatewayConfigurationError(
      "SOCIAL_GATEWAY_TIMEOUT_MS must be an integer between 100 and 60000",
    );
  }
  return parsed;
}

export function isSocialGatewayConfigured(): boolean {
  return Boolean(
    process.env.SOCIAL_GATEWAY_BASE_URL?.trim() &&
      process.env.SOCIAL_GATEWAY_API_KEY?.trim(),
  );
}

export function getSocialGatewayClient(): SocialGatewayClient | null {
  if (cachedClient !== undefined) return cachedClient;
  if (!isSocialGatewayConfigured()) {
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = new HttpSocialGatewayClient({
    baseUrl: process.env.SOCIAL_GATEWAY_BASE_URL ?? "",
    operatorApiKey: process.env.SOCIAL_GATEWAY_API_KEY ?? "",
    adminApiKey: process.env.SOCIAL_GATEWAY_ADMIN_API_KEY,
    agentCredential: process.env.SOCIAL_GATEWAY_AGENT_CREDENTIAL,
    actorRef: process.env.SOCIAL_GATEWAY_ACTOR_REF ?? "zernflow",
    workspaceRef: process.env.SOCIAL_GATEWAY_WORKSPACE_REF ?? "default",
    timeoutMs: parseTimeout(process.env.SOCIAL_GATEWAY_TIMEOUT_MS),
    production: process.env.NODE_ENV === "production",
  });
  return cachedClient;
}

export function requireSocialGatewayClient(): SocialGatewayClient {
  const client = getSocialGatewayClient();
  if (!client) {
    throw new SocialGatewayConfigurationError(
      "Agent Social Gateway is not configured for this deployment",
    );
  }
  return client;
}

export function resetSocialGatewayClientForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Social gateway client reset is restricted to tests");
  }
  cachedClient = undefined;
}

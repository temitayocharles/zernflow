import { describe, expect, it } from "vitest";
import { CONNECTORS, canStartOnboarding, hasCapability, isOAuthPlatform, isProjectionPlatform, resolveConnectorState } from "./registry";
import type { GatewayProviderReadiness } from "@/lib/social-gateway/types";

const readiness: GatewayProviderReadiness = { provider: "meta", configured: true, application: "app", platforms: ["facebook", "instagram"] };
describe("connector registry", () => {
  it("has unique projection identities including Telegram", () => {
    expect(new Set(CONNECTORS.map(c => c.id)).size).toBe(CONNECTORS.length);
    expect(isProjectionPlatform("telegram")).toBe(true);
    expect(isProjectionPlatform("unknown")).toBe(false);
  });
  it("only enables implemented and configured OAuth contracts", () => {
    expect(canStartOnboarding("facebook", readiness)).toBe(true);
    expect(canStartOnboarding("telegram", readiness)).toBe(false);
    expect(isOAuthPlatform(null)).toBe(false);
    expect(canStartOnboarding("facebook", null)).toBe(false);
    expect(canStartOnboarding("facebook", { ...readiness, configured: false })).toBe(false);
    expect(canStartOnboarding("facebook", { ...readiness, platforms: [] })).toBe(false);
    expect(canStartOnboarding("facebook", { ...readiness, provider: "other" })).toBe(false);
  });
  it.each([
    ["active", "connected"], ["pending", "configured"], ["degraded", "degraded"],
    ["error", "degraded"], ["disconnected", "unavailable"],
  ] as const)("maps live account %s to %s", (status, expected) => {
    expect(resolveConnectorState({ platform: "telegram", gatewayReachable: true, account: { platform: "telegram", status } })).toBe(expected);
  });
  it("does not infer health from readiness or mismatched accounts", () => {
    expect(resolveConnectorState({ platform: "facebook", gatewayReachable: true, readiness })).toBe("available");
    expect(resolveConnectorState({ platform: "telegram", gatewayReachable: true, account: { platform: "facebook", status: "active" } })).toBe("unavailable");
    expect(resolveConnectorState({ platform: "telegram", gatewayReachable: false, account: { platform: "telegram", status: "active" } })).toBe("unavailable");
    expect(resolveConnectorState({ platform: "unknown", gatewayReachable: true })).toBe("coming_later");
  });
  it("fails closed on missing, inherited, false, or unhealthy capabilities", () => {
    expect(hasCapability({ status: "active", capabilities: { messaging: true } }, "messaging")).toBe(true);
    for (const capabilities of [{}, { messaging: false }, Object.create({ messaging: true })]) {
      expect(hasCapability({ status: "active", capabilities }, "messaging")).toBe(false);
    }
    expect(hasCapability({ status: "degraded", capabilities: { messaging: true } }, "messaging")).toBe(false);
  });
});

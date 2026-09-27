import { capabilityOf, type BrowserAdapter, type BrowserOperation, type VerificationLevel } from "./contract";
import { facebookAdapter } from "./adapters/facebook";
import { instagramAdapter } from "./adapters/instagram";
import { linkedinAdapter } from "./adapters/linkedin";
import { tiktokAdapter } from "./adapters/tiktok";
import { xAdapter } from "./adapters/x";

const ADAPTERS: readonly BrowserAdapter[] = [instagramAdapter, facebookAdapter, tiktokAdapter, linkedinAdapter, xAdapter];

export function browserAdapter(platform: string): BrowserAdapter | null {
  return ADAPTERS.find((a) => a.platform === platform) ?? null;
}

export function browserPlatforms(): { platform: string; label: string; capabilities: BrowserAdapter["capabilities"] }[] {
  return ADAPTERS.map((a) => ({ platform: a.platform, label: a.label, capabilities: a.capabilities }));
}

export type Executor = "api" | "gateway" | "browser";

/**
 * Execution priority: official API → Gateway/OAuth adapter → managed browser.
 * Returns the first usable executor and why each other one was skipped.
 * Experimental browser capabilities need an explicit opt-in.
 */
export function resolveExecutor(input: {
  platform: string;
  operation: BrowserOperation;
  apiAvailable: boolean;
  gatewayAvailable: boolean;
  allowExperimental?: boolean;
}): { executor: Executor | null; level?: VerificationLevel; skipped: { executor: Executor; reason: string }[] } {
  const skipped: { executor: Executor; reason: string }[] = [];
  if (input.apiAvailable) return { executor: "api", skipped };
  skipped.push({ executor: "api", reason: "No official API adapter is connected for this operation." });
  if (input.gatewayAvailable) return { executor: "gateway", skipped };
  skipped.push({ executor: "gateway", reason: "The Gateway does not offer this operation for this platform." });
  const adapter = browserAdapter(input.platform);
  if (!adapter) {
    skipped.push({ executor: "browser", reason: "No browser adapter exists for this platform." });
    return { executor: null, skipped };
  }
  const cap = capabilityOf(adapter, input.operation);
  if (cap.level === "verified" || (cap.level === "experimental" && input.allowExperimental)) {
    return { executor: "browser", level: cap.level, skipped };
  }
  skipped.push({
    executor: "browser",
    reason: cap.level === "experimental" ? "Browser support is experimental and has not been enabled." : cap.note,
  });
  return { executor: null, skipped };
}

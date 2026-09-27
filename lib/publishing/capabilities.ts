import { browserAdapter } from "@/lib/browser/registry";
import { capabilityOf } from "@/lib/browser/contract";
import type { EditorialDraft } from "@/lib/product/types";
import { apiRouteReason, providerFromApiAdapter, registerPublishingProvider, type ApiPublishAdapter } from "./contract";
import { registerDefaultPublishingProviders } from "./gateway-provider";

registerDefaultPublishingProviders();

/**
 * Capability-driven publishing (TARGET_ARCHITECTURE §5). Each platform has a
 * static content profile (conservative, documented limits) and a set of
 * execution modes that are available only when an adapter is registered:
 *   api     → provider/Gateway adapter (API first)
 *   browser → managed browser adapter with a tested `publish_post` contract (R6)
 *   manual  → operator publishes and confirms the link (always available)
 * Nothing claims support that is not backed by a registered adapter.
 */
export type PublishMode = "api" | "browser" | "manual";
export type ContentKind = EditorialDraft["kind"];

export interface PlatformProfile {
  platform: string;
  label: string;
  maxTextLength: number;
  requiresMedia: boolean;
  mediaKinds: readonly ("image" | "video")[];
  maxMedia: number;
  /** Links in the post body are clickable. */
  supportsLinks: boolean;
  contentKinds: readonly ContentKind[];
}

export const PLATFORM_PROFILES: Record<string, PlatformProfile> = {
  facebook: { platform: "facebook", label: "Facebook", maxTextLength: 63206, requiresMedia: false, mediaKinds: ["image", "video"], maxMedia: 10, supportsLinks: true, contentKinds: ["post", "reel", "story", "carousel", "short_video"] },
  instagram: { platform: "instagram", label: "Instagram", maxTextLength: 2200, requiresMedia: true, mediaKinds: ["image", "video"], maxMedia: 10, supportsLinks: false, contentKinds: ["post", "reel", "story", "carousel", "short_video"] },
  twitter: { platform: "twitter", label: "X", maxTextLength: 280, requiresMedia: false, mediaKinds: ["image", "video"], maxMedia: 4, supportsLinks: true, contentKinds: ["post", "thread", "short_video"] },
  bluesky: { platform: "bluesky", label: "Bluesky", maxTextLength: 300, requiresMedia: false, mediaKinds: ["image", "video"], maxMedia: 4, supportsLinks: true, contentKinds: ["post", "thread"] },
  telegram: { platform: "telegram", label: "Telegram", maxTextLength: 4096, requiresMedia: false, mediaKinds: ["image", "video"], maxMedia: 10, supportsLinks: true, contentKinds: ["post", "article"] },
  reddit: { platform: "reddit", label: "Reddit", maxTextLength: 40000, requiresMedia: false, mediaKinds: ["image", "video"], maxMedia: 20, supportsLinks: true, contentKinds: ["post", "article"] },
  threads: { platform: "threads", label: "Threads", maxTextLength: 500, requiresMedia: false, mediaKinds: ["image", "video"], maxMedia: 10, supportsLinks: true, contentKinds: ["post", "thread", "carousel"] },
  linkedin: { platform: "linkedin", label: "LinkedIn", maxTextLength: 3000, requiresMedia: false, mediaKinds: ["image", "video"], maxMedia: 9, supportsLinks: true, contentKinds: ["post", "article", "carousel"] },
  tiktok: { platform: "tiktok", label: "TikTok", maxTextLength: 2200, requiresMedia: true, mediaKinds: ["video"], maxMedia: 1, supportsLinks: false, contentKinds: ["short_video"] },
  youtube: { platform: "youtube", label: "YouTube", maxTextLength: 5000, requiresMedia: true, mediaKinds: ["video"], maxMedia: 1, supportsLinks: true, contentKinds: ["short_video", "article"] },
};

export function profileFor(platform: string): PlatformProfile | null {
  return Object.hasOwn(PLATFORM_PROFILES, platform) ? PLATFORM_PROFILES[platform] : null;
}

export type { PublishPayload, PublishResult, ApiPublishAdapter } from "./contract";

/** Browser publishing contracts are registered by the browser plane (R6) — capability metadata only. */
const browserPublishers = new Map<string, readonly ContentKind[]>();

/** Compatibility seam (R4): synchronous adapters are wrapped into the provider-neutral contract (R10). */
export function registerApiPublishAdapter(adapter: ApiPublishAdapter): void {
  registerPublishingProvider(providerFromApiAdapter(adapter));
}

export function registerBrowserPublisher(platform: string, kinds: readonly ContentKind[]): void {
  browserPublishers.set(platform, kinds);
}

export interface ModeAvailability {
  mode: PublishMode;
  available: boolean;
  reason: string;
}

export function availableModes(platform: string, kind: ContentKind): ModeAvailability[] {
  const api = apiRouteReason(platform, kind);
  // Browser publishing needs both a registered publisher and a *verified* adapter capability
  // (live acceptance recorded). Experimental adapters never make publishing available.
  const adapter = browserAdapter(platform);
  const verified = adapter ? capabilityOf(adapter, "publish_post").level === "verified" : false;
  const browserKinds = verified ? browserPublishers.get(platform) : undefined;
  return [
    {
      mode: "api",
      available: api.available,
      reason: api.reason,
    },
    {
      mode: "browser",
      available: Boolean(browserKinds?.includes(kind)),
      reason: browserKinds?.includes(kind) ? "Published by the managed browser executor" : "No tested browser publishing adapter for this platform and content kind.",
    },
    { mode: "manual", available: true, reason: "You publish on the platform and confirm the post link here; ZernFlow reminds you when it is due." },
  ];
}

/** API first → browser → manual, unless a preferred available mode is requested. */
export function resolveMode(platform: string, kind: ContentKind, preferred?: PublishMode): { mode: PublishMode } | { error: string } {
  const modes = availableModes(platform, kind);
  if (preferred) {
    const m = modes.find((x) => x.mode === preferred);
    return m?.available ? { mode: preferred } : { error: m?.reason ?? "Unknown mode" };
  }
  return { mode: modes.find((m) => m.available)!.mode };
}

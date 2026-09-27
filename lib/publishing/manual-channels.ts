import { InputError } from "@/lib/product/validation";
import { profileFor } from "./capabilities";

/**
 * Operator-registered channels for platforms ZernFlow publishes to manually or
 * through the managed browser (00039). They carry no provider credentials and
 * never receive webhooks; the account ref is "manual:<platform>:<handle>".
 */
/**
 * Limited to platforms with no Gateway projection. Gateway platforms are connected
 * through the Gateway so inbox/automation features never see a credential-less copy.
 */
export const MANUAL_CHANNEL_PLATFORMS = ["threads", "linkedin", "tiktok", "youtube"] as const;
export type ManualChannelPlatform = (typeof MANUAL_CHANNEL_PLATFORMS)[number];

export interface ManualChannelInput {
  platform: ManualChannelPlatform;
  handle: string;
  displayName: string | null;
}

export function parseManualChannel(body: Record<string, unknown>): ManualChannelInput {
  const platform = body.platform;
  if (typeof platform !== "string" || !(MANUAL_CHANNEL_PLATFORMS as readonly string[]).includes(platform) || !profileFor(platform)) {
    throw new InputError(`platform must be one of ${MANUAL_CHANNEL_PLATFORMS.join(", ")}`);
  }
  const rawHandle = typeof body.handle === "string" ? body.handle.trim().replace(/^@/, "") : "";
  const handle = rawHandle.toLowerCase();
  if (!/^[a-z0-9._-]{1,100}$/.test(handle)) throw new InputError("handle must be 1-100 letters, digits, dots, dashes or underscores");
  const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim().slice(0, 200) : null;
  return { platform: platform as ManualChannelPlatform, handle, displayName };
}

export function manualAccountRef(input: Pick<ManualChannelInput, "platform" | "handle">): string {
  return `manual:${input.platform}:${input.handle}`;
}

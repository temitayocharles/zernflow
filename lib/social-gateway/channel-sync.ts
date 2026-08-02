import type { GatewayAccount } from "./types";
import type { Platform } from "@/lib/types/database";

const SUPPORTED_PLATFORMS = new Set<Platform>([
  "facebook",
  "instagram",
  "twitter",
  "telegram",
  "bluesky",
  "reddit",
  "whatsapp",
]);

export interface ExistingChannel {
  id: string;
  late_account_id: string;
  platform: Platform;
  username: string | null;
  display_name: string | null;
  profile_picture: string | null;
  is_active: boolean;
}

export interface ChannelCreatePlan {
  gatewayAccountId: string;
  platform: Platform;
  username: string | null;
  displayName: string | null;
  profilePicture: string | null;
  isActive: boolean;
}

export interface ChannelUpdatePlan {
  channelId: string;
  platform: Platform;
  username: string | null;
  displayName: string | null;
  profilePicture: string | null;
  isActive: boolean;
}

export interface UnsupportedGatewayAccount {
  gatewayAccountId: string;
  platform: string;
}

export interface ChannelSyncPlan {
  creates: ChannelCreatePlan[];
  updates: ChannelUpdatePlan[];
  deactivateChannelIds: string[];
  unsupported: UnsupportedGatewayAccount[];
}

function asSupportedPlatform(value: string): Platform | null {
  return SUPPORTED_PLATFORMS.has(value as Platform) ? (value as Platform) : null;
}

function displayName(account: GatewayAccount): string | null {
  return account.displayName ?? account.username ?? null;
}

function isActive(account: GatewayAccount): boolean {
  return account.status === "active";
}

export function planGatewayChannelSync(
  accounts: GatewayAccount[],
  existingChannels: ExistingChannel[],
): ChannelSyncPlan {
  const existingByGatewayId = new Map(
    existingChannels.map((channel) => [channel.late_account_id, channel]),
  );
  const observedAccountIds = new Set<string>();
  const creates: ChannelCreatePlan[] = [];
  const updates: ChannelUpdatePlan[] = [];
  const unsupported: UnsupportedGatewayAccount[] = [];

  for (const account of accounts) {
    observedAccountIds.add(account._id);
    const platform = asSupportedPlatform(account.platform);
    if (!platform) {
      unsupported.push({ gatewayAccountId: account._id, platform: account.platform });
      continue;
    }

    const desired = {
      platform,
      username: account.username,
      displayName: displayName(account),
      profilePicture: account.profilePicture,
      isActive: isActive(account),
    };
    const existing = existingByGatewayId.get(account._id);

    if (!existing) {
      creates.push({ gatewayAccountId: account._id, ...desired });
      continue;
    }

    if (
      existing.platform !== desired.platform ||
      existing.username !== desired.username ||
      existing.display_name !== desired.displayName ||
      existing.profile_picture !== desired.profilePicture ||
      existing.is_active !== desired.isActive
    ) {
      updates.push({ channelId: existing.id, ...desired });
    }
  }

  const deactivateChannelIds = existingChannels
    .filter(
      (channel) =>
        channel.is_active && !observedAccountIds.has(channel.late_account_id),
    )
    .map((channel) => channel.id);

  return { creates, updates, deactivateChannelIds, unsupported };
}

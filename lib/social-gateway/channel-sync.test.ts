import { describe, expect, it } from "vitest";
import { planGatewayChannelSync, type ExistingChannel } from "./channel-sync";
import type { GatewayAccount } from "./types";

function account(overrides: Partial<GatewayAccount> = {}): GatewayAccount {
  return {
    _id: "account-1",
    provider: "meta",
    platform: "instagram",
    username: "brand",
    displayName: "Brand",
    profilePicture: "https://cdn.example.test/avatar.png",
    external_account_ref: "external-1",
    status: "active",
    capabilities: {},
    token_expires_at: null,
    created_at: "2026-08-02T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    ...overrides,
  };
}

function channel(overrides: Partial<ExistingChannel> = {}): ExistingChannel {
  return {
    id: "channel-1",
    late_account_id: "account-1",
    platform: "instagram",
    username: "brand",
    display_name: "Brand",
    profile_picture: "https://cdn.example.test/avatar.png",
    is_active: true,
    ...overrides,
  };
}

describe("planGatewayChannelSync", () => {
  it("creates new supported gateway accounts", () => {
    const plan = planGatewayChannelSync([account()], []);

    expect(plan.creates).toEqual([
      {
        gatewayAccountId: "account-1",
        platform: "instagram",
        username: "brand",
        displayName: "Brand",
        profilePicture: "https://cdn.example.test/avatar.png",
        isActive: true,
      },
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.deactivateChannelIds).toEqual([]);
  });

  it("updates changed metadata and deactivated gateway accounts", () => {
    const plan = planGatewayChannelSync(
      [account({ displayName: "New Brand", status: "disconnected" })],
      [channel()],
    );

    expect(plan.updates).toEqual([
      {
        channelId: "channel-1",
        platform: "instagram",
        username: "brand",
        displayName: "New Brand",
        profilePicture: "https://cdn.example.test/avatar.png",
        isActive: false,
      },
    ]);
  });

  it("deactivates local channels that no longer exist in the gateway", () => {
    const plan = planGatewayChannelSync([], [channel()]);
    expect(plan.deactivateChannelIds).toEqual(["channel-1"]);
  });

  it("does not repeatedly deactivate an already inactive channel", () => {
    const plan = planGatewayChannelSync([], [channel({ is_active: false })]);
    expect(plan.deactivateChannelIds).toEqual([]);
  });

  it("reports unsupported account platforms without persisting them", () => {
    const plan = planGatewayChannelSync(
      [account({ _id: "generic-1", provider: "generic", platform: "generic" })],
      [],
    );

    expect(plan.creates).toEqual([]);
    expect(plan.unsupported).toEqual([
      { gatewayAccountId: "generic-1", platform: "generic" },
    ]);
  });

  it("does not emit updates when the local projection already matches", () => {
    const plan = planGatewayChannelSync([account()], [channel()]);
    expect(plan.updates).toEqual([]);
  });
});

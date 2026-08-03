import { describe, expect, it } from "vitest";
import { planGatewayConversationSync } from "./conversation-sync";
import type {
  GatewayConversationDetail,
  GatewayConversationSummary,
} from "./types";

function summary(
  overrides: Partial<GatewayConversationSummary> = {},
): GatewayConversationSummary {
  return {
    id: "conversation-1",
    provider: "telegram",
    provider_account_ref: "account-1",
    kind: "direct_message",
    external_thread_ref: "thread-1",
    subject_ref: null,
    last_message_at: "2026-08-02T18:00:00Z",
    participant_count: 1,
    latest_message_text: "Hello",
    latest_message_kind: "message",
    latest_message_direction: "inbound",
    ...overrides,
  };
}

function detail(
  conversation: GatewayConversationSummary,
  participantRef = "participant-1",
): GatewayConversationDetail {
  return {
    conversation,
    participants: [
      {
        id: "participant-row-1",
        external_participant_ref: participantRef,
        display_name: "Ada",
        metadata: {},
      },
    ],
    messages: [],
    next_message_cursor: null,
  };
}

describe("planGatewayConversationSync", () => {
  it("creates a conversation and reuses an existing contact identity", () => {
    const remote = summary();
    const plan = planGatewayConversationSync(
      [{ summary: remote, detail: detail(remote) }],
      [{ id: "channel-1", gatewayAccountId: "account-1", platform: "telegram" }],
      [],
      [
        {
          channelId: "channel-1",
          platformSenderId: "participant-1",
          contactId: "contact-1",
        },
      ],
    );

    expect(plan.creates).toEqual([
      expect.objectContaining({
        gatewayConversationId: "conversation-1",
        channelId: "channel-1",
        existingContactId: "contact-1",
      }),
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("updates only changed local conversation metadata", () => {
    const remote = summary({ latest_message_text: "Updated" });
    const plan = planGatewayConversationSync(
      [{ summary: remote, detail: detail(remote) }],
      [{ id: "channel-1", gatewayAccountId: "account-1", platform: "telegram" }],
      [
        {
          id: "local-conversation-1",
          gatewayConversationId: "conversation-1",
          channelId: "channel-1",
          contactId: "contact-1",
          lastMessageAt: remote.last_message_at,
          lastMessagePreview: "Old",
        },
      ],
      [],
    );

    expect(plan.updates).toEqual([
      {
        conversationId: "local-conversation-1",
        lastMessageAt: remote.last_message_at,
        lastMessagePreview: "Updated",
      },
    ]);
    expect(plan.creates).toEqual([]);
  });

  it("skips conversations whose provider account has not been projected", () => {
    const remote = summary();
    const plan = planGatewayConversationSync(
      [{ summary: remote, detail: detail(remote) }],
      [],
      [],
      [],
    );

    expect(plan.skipped).toEqual([
      {
        gatewayConversationId: "conversation-1",
        reason: "channel_not_projected",
      },
    ]);
  });

  it("skips new conversations without an external participant", () => {
    const remote = summary();
    const remoteDetail = detail(remote, "");
    const plan = planGatewayConversationSync(
      [{ summary: remote, detail: remoteDetail }],
      [{ id: "channel-1", gatewayAccountId: "account-1", platform: "telegram" }],
      [],
      [],
    );

    expect(plan.skipped).toEqual([
      {
        gatewayConversationId: "conversation-1",
        reason: "participant_not_available",
      },
    ]);
  });
});

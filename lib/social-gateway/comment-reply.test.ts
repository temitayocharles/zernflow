import { describe, expect, it, vi } from "vitest";
import {
  dispatchPublicCommentReply,
  GatewayCommentReplyPendingError,
} from "./comment-reply";
import type {
  GatewayOperation,
  SocialGatewayClient,
} from "./types";

function operation(
  status: GatewayOperation["status"],
  overrides: Partial<GatewayOperation> = {},
): GatewayOperation {
  return {
    id: "operation-1",
    type: "reply",
    idempotency_key: "comment-key-1",
    conversation_id: "conversation-1",
    message_id: "outbound-message-1",
    reply_to_message_id: "comment-message-1",
    integration_reference: null,
    scheduled_at: null,
    timezone: null,
    status,
    reconciliation_status: "not_required",
    attempt_count: 1,
    max_attempts: 3,
    retryable: status === "failed",
    external_reference: null,
    error_code: null,
    error_message: null,
    next_attempt_at: null,
    reconciled_at: null,
    dead_lettered_at: null,
    created_at: "2026-08-03T20:00:00Z",
    updated_at: "2026-08-03T20:00:00Z",
    ...overrides,
  };
}

function gatewayReturning(result: GatewayOperation): SocialGatewayClient {
  return {
    getProviderReadiness: vi.fn(),
    startConnection: vi.fn(),
    listAccounts: vi.fn(),
    listConversations: vi.fn(),
    getConversation: vi.fn(),
    replyToConversation: vi.fn().mockResolvedValue(result),
    createDraft: vi.fn(),
    assignConversation: vi.fn(),
    escalateConversation: vi.fn(),
    setHumanTakeover: vi.fn(),
    approveAction: vi.fn(),
    rejectAction: vi.fn(),
    getOperation: vi.fn(),
    retryOperation: vi.fn(),
  };
}

describe("dispatchPublicCommentReply", () => {
  it("targets the gateway comment message with a stable idempotency key", async () => {
    const gateway = gatewayReturning(operation("succeeded"));

    await expect(
      dispatchPublicCommentReply(gateway, {
        text: "Thanks for your comment",
        idempotencyKey: "zernflow:comment-reply:channel-1:comment-1",
        gatewayConversationId: "conversation-1",
        gatewayMessageId: "comment-message-1",
      }),
    ).resolves.toEqual({
      provider: "social_gateway",
      operationId: "operation-1",
    });

    expect(gateway.replyToConversation).toHaveBeenCalledWith("conversation-1", {
      text: "Thanks for your comment",
      idempotencyKey: "zernflow:comment-reply:channel-1:comment-1",
      replyToMessageId: "comment-message-1",
      deliveryMode: "conversation",
    });
  });

  it("keeps the webhook job retryable while the durable operation is pending", async () => {
    const gateway = gatewayReturning(operation("pending"));

    await expect(
      dispatchPublicCommentReply(gateway, {
        text: "Thanks",
        idempotencyKey: "comment-key-1",
        gatewayConversationId: "conversation-1",
        gatewayMessageId: "comment-message-1",
      }),
    ).rejects.toBeInstanceOf(GatewayCommentReplyPendingError);
  });

  it("surfaces terminal gateway failures instead of reporting a sent reply", async () => {
    const gateway = gatewayReturning(
      operation("failed", { error_message: "Provider rejected the reply" }),
    );

    await expect(
      dispatchPublicCommentReply(gateway, {
        text: "Thanks",
        idempotencyKey: "comment-key-1",
        gatewayConversationId: "conversation-1",
        gatewayMessageId: "comment-message-1",
      }),
    ).rejects.toThrow("Provider rejected the reply");
  });

  it("fails closed without gateway identities when migration mode is disabled", async () => {
    const previous = process.env.ENABLE_LEGACY_ZERNIO;
    process.env.ENABLE_LEGACY_ZERNIO = "false";
    try {
      await expect(
        dispatchPublicCommentReply(gatewayReturning(operation("succeeded")), {
          text: "Thanks",
          idempotencyKey: "comment-key-1",
        }),
      ).rejects.toThrow("requires the projected Agent Social Gateway");
    } finally {
      if (previous === undefined) delete process.env.ENABLE_LEGACY_ZERNIO;
      else process.env.ENABLE_LEGACY_ZERNIO = previous;
    }
  });
});

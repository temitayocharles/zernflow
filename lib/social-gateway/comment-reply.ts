import type {
  GatewayOperation,
  SocialGatewayClient,
} from "./types";
import {
  createZernioClient,
  isLegacyZernioEnabled,
} from "@/lib/zernio-client";

export interface PublicCommentReplyInput {
  text: string;
  idempotencyKey: string;
  gatewayConversationId?: string;
  gatewayMessageId?: string;
  legacy?: {
    apiKey: string;
    accountId: string;
    postId: string;
    commentId: string;
  };
}

export interface PublicCommentReplyResult {
  provider: "social_gateway" | "legacy_zernio";
  operationId: string | null;
}

export class GatewayCommentReplyPendingError extends Error {
  constructor(readonly operationId: string) {
    super(`Agent Social Gateway comment reply operation ${operationId} is still pending`);
    this.name = "GatewayCommentReplyPendingError";
  }
}

function assertSuccessfulOperation(operation: GatewayOperation): void {
  if (operation.status === "succeeded") return;
  if (operation.status === "pending" || operation.status === "running") {
    throw new GatewayCommentReplyPendingError(operation.id);
  }
  throw new Error(
    operation.error_message ??
      (operation.status === "unknown"
        ? "Public comment reply outcome is unknown and requires review"
        : "Agent Social Gateway public comment reply failed"),
  );
}

export async function dispatchPublicCommentReply(
  gateway: SocialGatewayClient,
  input: PublicCommentReplyInput,
): Promise<PublicCommentReplyResult> {
  const text = input.text.trim();
  if (!text) throw new Error("Public comment reply text is empty");

  if (input.gatewayConversationId && input.gatewayMessageId) {
    const operation = await gateway.replyToConversation(
      input.gatewayConversationId,
      {
        text,
        idempotencyKey: input.idempotencyKey,
        replyToMessageId: input.gatewayMessageId,
        deliveryMode: "conversation",
      },
    );
    assertSuccessfulOperation(operation);
    return { provider: "social_gateway", operationId: operation.id };
  }

  if (isLegacyZernioEnabled() && input.legacy) {
    const zernio = createZernioClient(input.legacy.apiKey);
    await zernio.comments.replyToInboxPost({
      path: { postId: input.legacy.postId },
      body: {
        accountId: input.legacy.accountId,
        message: text,
        commentId: input.legacy.commentId,
      },
    });
    return { provider: "legacy_zernio", operationId: null };
  }

  throw new Error(
    "Public comment reply requires the projected Agent Social Gateway conversation and message identities",
  );
}

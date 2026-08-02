import { describe, expect, it, vi } from "vitest";
import { HttpSocialGatewayClient } from "./client";

const OPERATOR_KEY = "operator-api-key-with-at-least-24-characters";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HttpSocialGatewayClient rich replies", () => {
  it("posts the normalized durable rich reply contract", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "operation-1",
        type: "reply",
        idempotency_key: "flow:session:node:1",
        conversation_id: "conversation-1",
        message_id: "message-1",
        reply_to_message_id: null,
        integration_reference: null,
        scheduled_at: null,
        timezone: null,
        status: "pending",
        reconciliation_status: "not_required",
        attempt_count: 0,
        max_attempts: 3,
        retryable: false,
        external_reference: null,
        error_code: null,
        error_message: null,
        next_attempt_at: null,
        reconciled_at: null,
        dead_lettered_at: null,
        created_at: "2026-08-02T00:00:00Z",
        updated_at: "2026-08-02T00:00:00Z",
      }),
    );
    const client = new HttpSocialGatewayClient({
      baseUrl: "https://gateway.example.test",
      operatorApiKey: OPERATOR_KEY,
      fetchImpl: fetchMock as typeof fetch,
      production: true,
    });

    await client.replyToConversation("conversation-1", {
      text: "Choose",
      attachments: [
        {
          type: "image",
          url: "https://cdn.example/product.jpg",
          mimeType: "image/jpeg",
        },
      ],
      presentation: {
        buttons: [
          {
            title: "Continue",
            type: "postback",
            payload: "continue",
          },
        ],
      },
      idempotencyKey: "flow:session:node:1",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://gateway.example.test/v1/conversations/conversation-1/replies",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Choose",
      attachments: [
        {
          type: "image",
          url: "https://cdn.example/product.jpg",
          mime_type: "image/jpeg",
        },
      ],
      presentation: {
        quick_replies: [],
        buttons: [
          {
            title: "Continue",
            type: "postback",
            payload: "continue",
          },
        ],
        carousel: [],
      },
      idempotency_key: "flow:session:node:1",
      reply_to_message_id: null,
    });
  });
});

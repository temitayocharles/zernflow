import { describe, expect, it, vi } from "vitest";
import { HttpSocialGatewayClient } from "./client";

const OPERATOR_KEY = "operator-api-key-with-at-least-24-characters";

describe("HttpSocialGatewayClient operation retries", () => {
  it("posts to the gateway retry endpoint with operator authentication", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "operation-1",
          type: "reply",
          idempotency_key: "sequence:enrollment:step:1",
          conversation_id: "conversation-1",
          message_id: "message-1",
          reply_to_message_id: null,
          integration_reference: null,
          scheduled_at: null,
          timezone: null,
          status: "pending",
          reconciliation_status: "not_required",
          attempt_count: 1,
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
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new HttpSocialGatewayClient({
      baseUrl: "https://gateway.example.test",
      operatorApiKey: OPERATOR_KEY,
      fetchImpl: fetchMock as typeof fetch,
      production: true,
    });

    await client.retryOperation("operation-1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://gateway.example.test/v1/operations/operation-1/retry",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-API-Key")).toBe(OPERATOR_KEY);
  });
});

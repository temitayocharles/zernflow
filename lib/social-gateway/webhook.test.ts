import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseSocialGatewayWebhookEnvelope,
  SOCIAL_GATEWAY_WEBHOOK_MAX_BODY_BYTES,
  verifySocialGatewayWebhook,
} from "./webhook";

const SECRET = "social-gateway-webhook-secret";
const NOW_MS = Date.UTC(2026, 7, 3, 20, 0, 0);
const TIMESTAMP = String(Math.floor(NOW_MS / 1000));

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function sign(rawBody: Uint8Array, timestamp = TIMESTAMP): string {
  return `sha256=${createHmac("sha256", SECRET)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex")}`;
}

function envelope() {
  return {
    schema_version: 1,
    id: "a44a75b4-9c89-4772-b51d-4e77a3694ca7",
    type: "message.received",
    occurred_at: "2026-08-03T19:59:58+00:00",
    received_at: "2026-08-03T20:00:00+00:00",
    provider: "generic",
    provider_account_id: "0fdb42c1-4b3e-4548-bcb2-9b72b6738bbb",
    provider_account_ref: "generic-account-1",
    conversation_id: "fd6d48b1-8c55-4dcf-8cda-49e1d653c744",
    message_id: "502bb08a-bac6-4e39-bc09-d5138e9855aa",
    data: {
      schema_version: 1,
      provider: "generic",
      provider_account_ref: "generic-account-1",
      event_type: "message",
      provider_event_id: "provider-event-1",
      idempotency_key: "a".repeat(64),
      occurred_at: "2026-08-03T19:59:58+00:00",
      external_conversation_ref: "provider-conversation-1",
      external_message_ref: "provider-message-1",
      external_parent_message_ref: null,
      actor: {
        external_id: "person-1",
        display_name: "Person One",
      },
      content: {
        text: "Hello from the gateway",
        attachments: [],
      },
      delivery_state: null,
      metadata: {},
    },
  } as const;
}

describe("verifySocialGatewayWebhook", () => {
  it("accepts a current canonical HMAC signature", () => {
    const rawBody = encode(envelope());

    expect(
      verifySocialGatewayWebhook({
        rawBody,
        signatureHeader: sign(rawBody),
        timestampHeader: TIMESTAMP,
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toEqual({ valid: true });
  });

  it("rejects a stale timestamp before processing the event", () => {
    const rawBody = encode(envelope());
    const staleTimestamp = String(Number(TIMESTAMP) - 301);

    expect(
      verifySocialGatewayWebhook({
        rawBody,
        signatureHeader: sign(rawBody, staleTimestamp),
        timestampHeader: staleTimestamp,
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toEqual({ valid: false, reason: "stale_timestamp" });
  });

  it("rejects a valid signature when the body was modified", () => {
    const original = encode(envelope());
    const modified = encode({ ...envelope(), provider_account_ref: "other-account" });

    expect(
      verifySocialGatewayWebhook({
        rawBody: modified,
        signatureHeader: sign(original),
        timestampHeader: TIMESTAMP,
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toEqual({ valid: false, reason: "invalid_signature" });
  });

  it("rejects requests without both authentication headers", () => {
    expect(
      verifySocialGatewayWebhook({
        rawBody: encode(envelope()),
        signatureHeader: null,
        timestampHeader: TIMESTAMP,
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toEqual({ valid: false, reason: "missing_headers" });
  });
});

describe("parseSocialGatewayWebhookEnvelope", () => {
  it("parses the provider-neutral identity and message references", () => {
    const parsed = parseSocialGatewayWebhookEnvelope(encode(envelope()));

    expect(parsed.provider_account_id).toBe(
      "0fdb42c1-4b3e-4548-bcb2-9b72b6738bbb",
    );
    expect(parsed.conversation_id).toBe("fd6d48b1-8c55-4dcf-8cda-49e1d653c744");
    expect(parsed.data.actor.external_id).toBe("person-1");
    expect(parsed.data.content.text).toBe("Hello from the gateway");
  });

  it("rejects an event that cannot identify the projected gateway account", () => {
    const { provider_account_id: _removed, ...invalid } = envelope();

    expect(() => parseSocialGatewayWebhookEnvelope(encode(invalid))).toThrow(
      "social gateway webhook envelope is invalid",
    );
  });

  it("rejects a body above the bounded webhook limit", () => {
    const oversized = new Uint8Array(SOCIAL_GATEWAY_WEBHOOK_MAX_BODY_BYTES + 1);

    expect(() => parseSocialGatewayWebhookEnvelope(oversized)).toThrow(
      "social gateway webhook body exceeds the configured limit",
    );
  });
});

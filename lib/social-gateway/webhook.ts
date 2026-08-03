import { createHmac, timingSafeEqual } from "node:crypto";

export const SOCIAL_GATEWAY_WEBHOOK_MAX_BODY_BYTES = 1_048_576;
export const SOCIAL_GATEWAY_WEBHOOK_TOLERANCE_SECONDS = 300;

export type SocialGatewayWebhookEventType =
  | "message.received"
  | "comment.received"
  | "reply.received"
  | "message.delivery_status"
  | "event.unsupported";

export interface SocialGatewayWebhookActor {
  external_id: string | null;
  display_name: string | null;
}

export interface SocialGatewayWebhookAttachment {
  type: string;
  external_id?: string | null;
  mime_type?: string | null;
}

export interface SocialGatewayNormalizedEvent {
  schema_version: 1;
  provider: string;
  provider_account_ref: string;
  event_type: string;
  provider_event_id?: string | null;
  idempotency_key?: string;
  occurred_at?: string;
  external_conversation_ref?: string | null;
  external_message_ref?: string | null;
  external_parent_message_ref?: string | null;
  actor: SocialGatewayWebhookActor;
  content: {
    text: string | null;
    attachments: SocialGatewayWebhookAttachment[];
  };
  delivery_state?: string | null;
  metadata: Record<string, unknown>;
}

export interface SocialGatewayWebhookEnvelope {
  schema_version: 1;
  id: string;
  type: SocialGatewayWebhookEventType;
  occurred_at: string;
  received_at: string;
  provider: string;
  provider_account_id: string;
  provider_account_ref: string;
  conversation_id: string | null;
  message_id: string | null;
  data: SocialGatewayNormalizedEvent;
}

export type SocialGatewayWebhookVerification =
  | { valid: true }
  | {
      valid: false;
      reason:
        | "missing_headers"
        | "invalid_timestamp"
        | "stale_timestamp"
        | "invalid_signature";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isEventType(value: unknown): value is SocialGatewayWebhookEventType {
  return (
    value === "message.received" ||
    value === "comment.received" ||
    value === "reply.received" ||
    value === "message.delivery_status" ||
    value === "event.unsupported"
  );
}

function secureHexEqual(expected: string, received: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

export function verifySocialGatewayWebhook({
  rawBody,
  signatureHeader,
  timestampHeader,
  secret,
  nowMs = Date.now(),
  toleranceSeconds = SOCIAL_GATEWAY_WEBHOOK_TOLERANCE_SECONDS,
}: {
  rawBody: Uint8Array;
  signatureHeader: string | null;
  timestampHeader: string | null;
  secret: string;
  nowMs?: number;
  toleranceSeconds?: number;
}): SocialGatewayWebhookVerification {
  if (!signatureHeader || !timestampHeader) {
    return { valid: false, reason: "missing_headers" };
  }

  if (!/^\d{10,13}$/.test(timestampHeader)) {
    return { valid: false, reason: "invalid_timestamp" };
  }
  const rawTimestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(rawTimestamp)) {
    return { valid: false, reason: "invalid_timestamp" };
  }
  const timestampMs = timestampHeader.length === 13 ? rawTimestamp : rawTimestamp * 1000;
  if (Math.abs(nowMs - timestampMs) > toleranceSeconds * 1000) {
    return { valid: false, reason: "stale_timestamp" };
  }

  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader.trim());
  if (!match) return { valid: false, reason: "invalid_signature" };
  const expected = createHmac("sha256", secret)
    .update(`${timestampHeader}.`)
    .update(rawBody)
    .digest("hex");
  if (!secureHexEqual(expected, match[1])) {
    return { valid: false, reason: "invalid_signature" };
  }
  return { valid: true };
}

export function parseSocialGatewayWebhookEnvelope(
  rawBody: Uint8Array,
): SocialGatewayWebhookEnvelope {
  if (rawBody.byteLength > SOCIAL_GATEWAY_WEBHOOK_MAX_BODY_BYTES) {
    throw new Error("social gateway webhook body exceeds the configured limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    throw new Error("social gateway webhook body is not valid JSON");
  }

  if (!isRecord(parsed)) throw new Error("social gateway webhook envelope is invalid");
  if (parsed.schema_version !== 1) {
    throw new Error("social gateway webhook schema version is unsupported");
  }
  if (
    typeof parsed.id !== "string" ||
    !isEventType(parsed.type) ||
    typeof parsed.occurred_at !== "string" ||
    typeof parsed.received_at !== "string" ||
    typeof parsed.provider !== "string" ||
    typeof parsed.provider_account_id !== "string" ||
    typeof parsed.provider_account_ref !== "string" ||
    !isStringOrNull(parsed.conversation_id) ||
    !isStringOrNull(parsed.message_id) ||
    !isRecord(parsed.data)
  ) {
    throw new Error("social gateway webhook envelope is invalid");
  }

  const data = parsed.data;
  if (
    data.schema_version !== 1 ||
    typeof data.provider !== "string" ||
    typeof data.provider_account_ref !== "string" ||
    typeof data.event_type !== "string" ||
    !isRecord(data.actor) ||
    !isRecord(data.content) ||
    !isRecord(data.metadata)
  ) {
    throw new Error("social gateway normalized event is invalid");
  }
  if (
    !isStringOrNull(data.actor.external_id) ||
    !isStringOrNull(data.actor.display_name) ||
    !isStringOrNull(data.content.text) ||
    !Array.isArray(data.content.attachments)
  ) {
    throw new Error("social gateway normalized event is invalid");
  }

  return parsed as unknown as SocialGatewayWebhookEnvelope;
}

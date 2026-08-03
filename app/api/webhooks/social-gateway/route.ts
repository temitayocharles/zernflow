import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import {
  parseSocialGatewayWebhookEnvelope,
  SOCIAL_GATEWAY_WEBHOOK_MAX_BODY_BYTES,
  verifySocialGatewayWebhook,
} from "@/lib/social-gateway/webhook";
import type { Json } from "@/lib/types/database";

export const runtime = "nodejs";

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  const secret = process.env.SOCIAL_GATEWAY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return jsonError("Social Gateway webhook receiver is not configured", 503);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > SOCIAL_GATEWAY_WEBHOOK_MAX_BODY_BYTES) {
    return jsonError("Webhook body exceeds the configured limit", 413);
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > SOCIAL_GATEWAY_WEBHOOK_MAX_BODY_BYTES) {
    return jsonError("Webhook body exceeds the configured limit", 413);
  }

  const verification = verifySocialGatewayWebhook({
    rawBody,
    signatureHeader: request.headers.get("x-agent-social-gateway-signature"),
    timestampHeader: request.headers.get("x-agent-social-gateway-timestamp"),
    secret,
  });
  if (!verification.valid) {
    return NextResponse.json(
      { error: "Webhook authentication failed", reason: verification.reason },
      { status: 401 },
    );
  }

  let envelope;
  try {
    envelope = parseSocialGatewayWebhookEnvelope(rawBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid webhook envelope";
    return jsonError(message, message.includes("exceeds") ? 413 : 400);
  }

  const headerEventId = request.headers.get("x-agent-social-gateway-event-id");
  const headerEventType = request.headers.get("x-agent-social-gateway-event-type");
  const deliveryId = request.headers.get("x-agent-social-gateway-delivery-id");
  if (!headerEventId || !headerEventType || !deliveryId) {
    return jsonError("Webhook identity headers are required", 400);
  }
  if (headerEventId !== envelope.id || headerEventType !== envelope.type) {
    return jsonError("Webhook identity headers do not match the signed envelope", 400);
  }

  const supabase = await createServiceClient();
  const { data: channel, error: channelError } = await supabase
    .from("channels")
    .select("id")
    .eq("late_account_id", envelope.provider_account_id)
    .eq("is_active", true)
    .maybeSingle();

  if (channelError) {
    console.error("Social Gateway channel lookup failed", {
      eventId: envelope.id,
      error: channelError.message,
    });
    return jsonError("Channel lookup failed", 500);
  }
  if (!channel) {
    return jsonError("No active channel projects this gateway account", 404);
  }

  const { data: claimResult, error: claimError } = await supabase.rpc(
    "claim_social_gateway_webhook",
    {
      p_event_id: envelope.id,
      p_delivery_id: deliveryId,
      p_event_type: envelope.type,
      p_channel_id: channel.id,
      p_envelope: envelope as unknown as Json,
    },
  );

  if (claimError) {
    console.error("Social Gateway webhook claim failed", {
      eventId: envelope.id,
      deliveryId,
      error: claimError.message,
    });
    return jsonError("Webhook could not be queued", 500);
  }

  if (claimResult === "completed") {
    return NextResponse.json({ ok: true, duplicate: true, status: "completed" });
  }
  if (claimResult === "already_queued") {
    return NextResponse.json(
      { ok: true, duplicate: true, status: "processing" },
      { status: 202 },
    );
  }

  return NextResponse.json(
    { ok: true, queued: true, status: claimResult ?? "queued" },
    { status: 202 },
  );
}

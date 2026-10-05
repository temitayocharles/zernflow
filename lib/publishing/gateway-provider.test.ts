import { afterEach, describe, expect, it } from "vitest";
import type { GatewayOperation } from "@/lib/social-gateway/types";
import { SocialGatewayError } from "@/lib/social-gateway/client";
import { availableModes } from "./capabilities";
import { apiProviderFor, apiRouteReason } from "./contract";
import {
  GATEWAY_PUBLISHING_BLOCKED_REASON,
  blockedGatewayPublishingTransport,
  createGatewayPublishingProvider,
  httpGatewayPublishingTransport,
  outcomeFromGatewayOperation,
  registerGatewayPublishingTransport,
  type GatewayPublishingTransport,
} from "./gateway-provider";

const NOW = Date.parse("2026-09-25T12:00:00Z");

function op(p: Partial<GatewayOperation> = {}): GatewayOperation {
  return {
    id: "op-1", type: "publish", idempotency_key: "k", conversation_id: null, message_id: null, reply_to_message_id: null,
    integration_reference: null, scheduled_at: null, timezone: null, status: "pending", reconciliation_status: "not_required",
    attempt_count: 0, max_attempts: 3, retryable: true, external_reference: null, error_code: null, error_message: null,
    next_attempt_at: null, reconciled_at: null, dead_lettered_at: null, created_at: "2026-09-25T11:59:00Z", updated_at: "2026-09-25T11:59:00Z",
    ...p,
  };
}

const req = { workspaceId: "w", variantId: "v", channelId: "c", accountRef: "acc", platform: "instagram", kind: "post" as const, text: "t", media: [], idempotencyKey: "k", attempt: 1 };

describe("Gateway operation → publish outcome", () => {
  it("maps every operation status without inventing data", () => {
    expect(outcomeFromGatewayOperation(op(), NOW)).toEqual({ status: "accepted", operationRef: "op-1", pollAfterMs: 30_000 });
    expect(outcomeFromGatewayOperation(op({ status: "running", next_attempt_at: "2026-09-25T12:02:00Z" }), NOW)).toMatchObject({ pollAfterMs: 120_000 });
    expect(outcomeFromGatewayOperation(op({ status: "succeeded", external_reference: "17890" }), NOW)).toEqual({ status: "published", externalRef: "17890", externalUrl: null });
    // Gateway will retry by itself → keep polling.
    expect(outcomeFromGatewayOperation(op({ status: "failed", retryable: true, attempt_count: 1, next_attempt_at: "2026-09-25T12:00:01Z" }), NOW)).toMatchObject({ status: "accepted", pollAfterMs: 5_000 });
    // Exhausted / dead-lettered / non-retryable → final failure (ZernFlow must not resubmit).
    expect(outcomeFromGatewayOperation(op({ status: "failed", retryable: true, dead_lettered_at: "x", error_code: "provider_down" }), NOW)).toMatchObject({ status: "failed", errorClass: "transient", final: true, code: "provider_down" });
    expect(outcomeFromGatewayOperation(op({ status: "failed", retryable: false, error_message: "caption rejected" }), NOW)).toMatchObject({ status: "failed", errorClass: "validation", final: true, message: "caption rejected" });
    expect(outcomeFromGatewayOperation(op({ status: "unknown" }), NOW)).toMatchObject({ status: "unknown", operationRef: "op-1" });
    expect(outcomeFromGatewayOperation(op({ status: "succeeded", reconciliation_status: "required" }), NOW)).toMatchObject({ status: "unknown" });
  });
});

describe("blocked Gateway transport (EXTERNAL_CONTRACT)", () => {
  it("is registered by default but never available, and explains why", async () => {
    expect(apiProviderFor("instagram", "post")).toBeNull();
    expect(apiRouteReason("instagram", "post")).toEqual({ available: false, reason: GATEWAY_PUBLISHING_BLOCKED_REASON, providerId: null });
    const api = availableModes("instagram", "post").find((m) => m.mode === "api")!;
    expect(api).toEqual({ mode: "api", available: false, reason: GATEWAY_PUBLISHING_BLOCKED_REASON });
    // Platforms the Gateway does not model get the generic reason.
    expect(apiRouteReason("tiktok", "short_video").reason).toMatch(/No API publishing provider/);

    const provider = createGatewayPublishingProvider(blockedGatewayPublishingTransport());
    expect(provider.idempotentSubmit).toBe(false);
    expect(await provider.submit(req, AbortSignal.timeout(1000))).toMatchObject({ status: "failed", errorClass: "unsupported_capability", final: true });
    await expect(blockedGatewayPublishingTransport().submitPublication({} as never, AbortSignal.timeout(1000))).rejects.toMatchObject({ errorClass: "unsupported_capability" });
  });
});

describe("concrete Gateway transport seam", () => {
  afterEach(() => registerGatewayPublishingTransport(blockedGatewayPublishingTransport()));

  function transport(over: Partial<GatewayPublishingTransport> = {}): GatewayPublishingTransport & { intents: unknown[] } {
    const intents: unknown[] = [];
    return {
      available: true, idempotentSubmit: true, unavailableReason: "n/a",
      supports: [{ platform: "instagram", kinds: ["post"] }],
      async submitPublication(intent) { intents.push(intent); return op(); },
      async getOperation() { return op({ status: "succeeded", external_reference: "ig-1" }); },
      ...over, intents,
    };
  }

  it("becomes available only for declared platform/kinds and maps submit + status", async () => {
    const t = transport();
    registerGatewayPublishingTransport(t);
    expect(apiProviderFor("instagram", "post")?.id).toBe("agent-social-gateway");
    expect(apiProviderFor("instagram", "reel")).toBeNull();
    expect(availableModes("instagram", "post").find((m) => m.mode === "api")?.available).toBe(true);

    const provider = apiProviderFor("instagram", "post")!;
    expect(provider.idempotentSubmit).toBe(true);
    expect(await provider.submit({ ...req, media: [{ artifactId: "a", contentType: "image/png", url: "https://s3/x" }] }, AbortSignal.timeout(1000))).toMatchObject({ status: "accepted", operationRef: "op-1" });
    expect(t.intents[0]).toEqual({ idempotencyKey: "k", accountRef: "acc", platform: "instagram", kind: "post", text: "t", media: [{ url: "https://s3/x", contentType: "image/png" }] });
    expect(await provider.status!("op-1", AbortSignal.timeout(1000))).toMatchObject({ status: "published", externalRef: "ig-1" });
  });

  it("classifies transport errors: 429 stays failed, 5xx is transient (idempotent), status 404 is unknown", async () => {
    registerGatewayPublishingTransport(transport({
      async submitPublication() { throw new SocialGatewayError("rate_limited", "rate limited", { status: 429 }); },
      async getOperation() { throw new SocialGatewayError("not_found", "not found", { status: 404 }); },
    }));
    const provider = apiProviderFor("instagram", "post")!;
    expect(await provider.submit(req, AbortSignal.timeout(1000))).toMatchObject({ status: "failed", errorClass: "rate_limited" });
    expect(await provider.status!("op-1", AbortSignal.timeout(1000))).toMatchObject({ status: "unknown", operationRef: "op-1" });

    registerGatewayPublishingTransport(transport({
      async getOperation() { throw new SocialGatewayError("upstream", "bad gateway", { status: 502 }); },
    }));
    expect(await apiProviderFor("instagram", "post")!.status!("op-1", AbortSignal.timeout(1000))).toMatchObject({ status: "accepted", pollAfterMs: 60_000 });
  });
});


describe("published Gateway HTTP transport", () => {
  const operation = op({ id: "op-publication", idempotency_key: "publish:variant:v1:1" });

  it("submits the published wire contract with operator auth and polls the operation", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(operation), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const transport = httpGatewayPublishingTransport({
      baseUrl: "https://gateway.example.test",
      apiKey: "operator-api-key-with-at-least-24-characters",
      actorRef: "zernflow:test",
      workspaceRef: "workspace-test",
      fetchImpl,
      production: true,
    });

    expect(transport.available).toBe(true);
    expect(transport.idempotentSubmit).toBe(true);
    expect(transport.supports).toEqual([{ platform: "facebook", kinds: ["post"] }]);

    await transport.submitPublication(
      {
        accountRef: "0d4d5b1c-7e63-4cb7-a56b-d221d913e6e2",
        platform: "facebook",
        kind: "post",
        text: "Launch update",
        media: [{ url: "https://cdn.example.test/a.png", contentType: "image/png" }],
        idempotencyKey: "publish:variant:v1:1",
      },
      AbortSignal.timeout(1000),
    );
    await transport.getOperation("op-publication");

    expect(calls[0]?.url).toBe("https://gateway.example.test/v1/publications");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("X-API-Key")).toBe("operator-api-key-with-at-least-24-characters");
    expect(headers.get("X-Actor-Ref")).toBe("zernflow:test");
    expect(headers.get("X-Workspace-Ref")).toBe("workspace-test");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      account_ref: "0d4d5b1c-7e63-4cb7-a56b-d221d913e6e2",
      platform: "facebook",
      kind: "post",
      text: "Launch update",
      media: [{ url: "https://cdn.example.test/a.png", content_type: "image/png" }],
      idempotency_key: "publish:variant:v1:1",
    });
    expect(calls[1]?.url).toBe("https://gateway.example.test/v1/operations/op-publication");
    expect(calls[1]?.init?.method).toBe("GET");
  });

  it("maps published Gateway errors into SocialGatewayError without leaking bodies", async () => {
    const transport = httpGatewayPublishingTransport({
      baseUrl: "https://gateway.example.test",
      apiKey: "operator-api-key-with-at-least-24-characters",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ detail: { code: "publication_account_not_found", message: "account unavailable" } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
      production: true,
    });
    await expect(
      transport.submitPublication(
        { accountRef: "missing", platform: "facebook", kind: "post", text: "x", media: [], idempotencyKey: "publish:test:1" },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: "publication_account_not_found", status: 404, retryable: false });
  });
});

import { planGatewayChannelSync } from "@/lib/social-gateway/channel-sync";
import { manualAccountRef, parseManualChannel } from "./manual-channels";

describe("manual channels", () => {
  it("parses and normalises owner input; rejects Gateway platforms and bad handles", () => {
    expect(parseManualChannel({ platform: "linkedin", handle: " @Brand.Co ", displayName: "Brand" })).toEqual({ platform: "linkedin", handle: "brand.co", displayName: "Brand" });
    expect(manualAccountRef({ platform: "tiktok", handle: "brand" })).toBe("manual:tiktok:brand");
    expect(() => parseManualChannel({ platform: "facebook", handle: "x" })).toThrow(/platform must be/);
    expect(() => parseManualChannel({ platform: "youtube", handle: "has space" })).toThrow(/handle/);
  });

  it("Gateway sync never updates or deactivates manual channels", () => {
    const plan = planGatewayChannelSync(
      [{ _id: "manual:linkedin:spoof", platform: "facebook", status: "active" } as never],
      [
        { id: "c1", late_account_id: "manual:linkedin:brand", platform: "linkedin", username: "brand", display_name: null, profile_picture: null, is_active: true } as never,
        { id: "c2", late_account_id: "gw-gone", platform: "facebook", username: null, display_name: null, profile_picture: null, is_active: true } as never,
      ],
    );
    expect(plan.deactivateChannelIds).toEqual(["c2"]);
    expect(plan.creates).toEqual([]);
    expect(plan.unsupported).toEqual([{ gatewayAccountId: "manual:linkedin:spoof", platform: "facebook" }]);
  });
});

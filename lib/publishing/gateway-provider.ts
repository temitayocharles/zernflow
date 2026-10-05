import { SocialGatewayError } from "@/lib/social-gateway/client";
import type { GatewayOperation, SocialGatewayClient } from "@/lib/social-gateway/types";
import { TaskError } from "@/lib/tasks/errors";
import {
  outcomeFromError,
  registerPublishingProvider,
  type ContentKind,
  type PublishOutcome,
  type PublishRequest,
  type PublishingProvider,
} from "./contract";

/**
 * Agent Social Gateway publishing adapter (R10).
 *
 * The Gateway is the preferred provider/action boundary. ZernFlow uses the
 * published durable publication contract: `POST /v1/publications` for
 * idempotent submission and `GET /v1/operations/{id}` for polling.
 *
 * The seam stays deliberately narrow: one method to submit and one to read an
 * operation, so the provider-neutral publishing engine remains unchanged.
 */

/**
 * ZernFlow-side description of a publication handed to the transport. The
 * concrete HTTP transport maps it onto the published Gateway wire contract.
 */
export interface PublicationIntent {
  idempotencyKey: string;
  accountRef: string;
  platform: string;
  kind: ContentKind;
  text: string;
  media: { url: string; contentType: string }[];
}

export interface GatewayPublishingTransport {
  /** True only for a transport that implements a published Gateway publishing contract. */
  readonly available: boolean;
  /** True when the Gateway deduplicates submissions by idempotency key (must be stated by the contract). */
  readonly idempotentSubmit: boolean;
  /** Platform/kind pairs the Gateway contract states it can publish. Empty while unavailable. */
  readonly supports: readonly { platform: string; kinds: readonly ContentKind[] }[];
  /** Human-readable reason shown while unavailable. */
  readonly unavailableReason: string;
  submitPublication(intent: PublicationIntent, signal: AbortSignal): Promise<GatewayOperation>;
  getOperation(operationId: string): Promise<GatewayOperation>;
}

export const GATEWAY_PUBLISHING_BLOCKED_REASON =
  "Agent Social Gateway publishing is unavailable because the server-side Gateway connection is not configured. Use manual or browser publishing.";

/** Platforms the Gateway account model knows (GatewayAccountPlatform minus "generic"). */
export const GATEWAY_ACCOUNT_PLATFORMS = ["facebook", "instagram", "telegram", "twitter", "bluesky", "reddit"] as const;

export class GatewayPublishingUnavailableError extends TaskError {
  constructor() {
    super("unsupported_capability", GATEWAY_PUBLISHING_BLOCKED_REASON);
    this.name = "GatewayPublishingUnavailableError";
  }
}

/**
 * Blocked transport used when the server-side Gateway connection is absent.
 * Operation reads may still delegate to an existing Gateway client in tests.
 */
export function blockedGatewayPublishingTransport(
  operations?: Pick<SocialGatewayClient, "getOperation"> | null,
): GatewayPublishingTransport {
  return {
    available: false,
    idempotentSubmit: false,
    supports: [],
    unavailableReason: GATEWAY_PUBLISHING_BLOCKED_REASON,
    async submitPublication() {
      throw new GatewayPublishingUnavailableError();
    },
    async getOperation(id) {
      if (!operations) throw new GatewayPublishingUnavailableError();
      return operations.getOperation(id);
    },
  };
}


export interface HttpGatewayPublishingTransportOptions {
  baseUrl: string;
  apiKey: string;
  actorRef?: string;
  workspaceRef?: string;
  fetchImpl?: typeof fetch;
  production?: boolean;
}

interface GatewayErrorEnvelope {
  detail?: { code?: unknown; message?: unknown };
}

function gatewayUrl(raw: string, path: string, production: boolean): URL {
  const base = new URL(raw);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.hash) {
    throw new Error("Invalid Agent Social Gateway URL");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(base.hostname);
  if (production && base.protocol !== "https:" && !loopback) {
    throw new Error("Agent Social Gateway must use HTTPS in production");
  }
  base.pathname = base.pathname.replace(/\/+$/, "");
  return new URL(`${base.pathname}${path}`.replace(/\/+/g, "/"), base);
}

async function gatewayHttpError(response: Response): Promise<SocialGatewayError> {
  let code = `social_gateway_http_${response.status}`;
  let message = "Social gateway request failed";
  try {
    const body = (await response.json()) as GatewayErrorEnvelope;
    if (typeof body.detail?.code === "string") code = body.detail.code;
    if (typeof body.detail?.message === "string") message = body.detail.message;
  } catch {
    // Keep status-derived fallback without leaking an upstream response body.
  }
  return new SocialGatewayError(code, message, {
    status: response.status,
    retryable:
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500,
  });
}

export function httpGatewayPublishingTransport(
  options: HttpGatewayPublishingTransportOptions,
): GatewayPublishingTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const production = options.production ?? false;
  const headers = (body: boolean) => {
    const h = new Headers({
      Accept: "application/json",
      "X-API-Key": options.apiKey,
      "X-Actor-Ref": options.actorRef?.trim() || "zernflow",
      "X-Workspace-Ref": options.workspaceRef?.trim() || "default",
    });
    if (body) h.set("Content-Type", "application/json");
    return h;
  };
  const request = async <T>(
    path: string,
    init: { method?: "GET" | "POST"; body?: Record<string, unknown>; signal?: AbortSignal } = {},
  ): Promise<T> => {
    try {
      const response = await fetchImpl(gatewayUrl(options.baseUrl, path, production), {
        method: init.method ?? "GET",
        headers: headers(init.body !== undefined),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        cache: "no-store",
        signal: init.signal,
      });
      if (!response.ok) throw await gatewayHttpError(response);
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof SocialGatewayError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new SocialGatewayError("social_gateway_timeout", "Social gateway request timed out", {
          retryable: true,
          cause: error,
        });
      }
      throw new SocialGatewayError(
        "social_gateway_unavailable",
        "Social gateway is unavailable",
        { retryable: true, cause: error },
      );
    }
  };
  return {
    available: true,
    idempotentSubmit: true,
    supports: [{ platform: "facebook", kinds: ["post"] }],
    unavailableReason: "The Agent Social Gateway does not advertise this publication capability.",
    async submitPublication(intent, signal) {
      return request<GatewayOperation>("/v1/publications", {
        method: "POST",
        signal,
        body: {
          account_ref: intent.accountRef,
          platform: intent.platform,
          kind: intent.kind,
          text: intent.text,
          media: intent.media.map((m) => ({ url: m.url, content_type: m.contentType })),
          idempotency_key: intent.idempotencyKey,
        },
      });
    },
    async getOperation(operationId) {
      return request<GatewayOperation>(
        `/v1/operations/${encodeURIComponent(operationId)}`,
      );
    },
  };
}

export function environmentGatewayPublishingTransport(): GatewayPublishingTransport {
  const baseUrl =
    typeof process === "undefined" ? "" : process.env.SOCIAL_GATEWAY_BASE_URL?.trim() ?? "";
  const apiKey =
    typeof process === "undefined" ? "" : process.env.SOCIAL_GATEWAY_API_KEY?.trim() ?? "";
  if (!baseUrl || apiKey.length < 24) return blockedGatewayPublishingTransport();
  try {
    return httpGatewayPublishingTransport({
      baseUrl,
      apiKey,
      actorRef: process.env.SOCIAL_GATEWAY_ACTOR_REF,
      workspaceRef: process.env.SOCIAL_GATEWAY_WORKSPACE_REF,
      production: process.env.NODE_ENV === "production",
    });
  } catch {
    return blockedGatewayPublishingTransport();
  }
}

const MIN_POLL_MS = 5_000;
const DEFAULT_POLL_MS = 30_000;

/**
 * Maps a Gateway operation onto the provider-neutral outcome.
 *  - pending/running, or failed-but-scheduled-for-Gateway-retry → accepted (keep polling)
 *  - succeeded → published (external_reference; no URL is invented)
 *  - failed (dead-lettered or not retryable) → failed, final (the Gateway owns retries of its operations)
 *  - unknown, or reconciliation required → unknown (operator must reconcile)
 */
export function outcomeFromGatewayOperation(op: GatewayOperation, now = Date.now()): PublishOutcome {
  const pollAfter = () => {
    const at = op.next_attempt_at ? Date.parse(op.next_attempt_at) : NaN;
    return Number.isFinite(at) ? Math.max(MIN_POLL_MS, at - now) : DEFAULT_POLL_MS;
  };
  if (op.reconciliation_status === "required") {
    return { status: "unknown", operationRef: op.id, message: "The Gateway flagged this publication for reconciliation; check the platform before retrying." };
  }
  switch (op.status) {
    case "pending":
    case "running":
      return { status: "accepted", operationRef: op.id, pollAfterMs: pollAfter() };
    case "succeeded":
      return { status: "published", externalRef: op.external_reference ? op.external_reference.slice(0, 300) : null, externalUrl: null };
    case "failed":
      if (op.retryable && !op.dead_lettered_at && op.next_attempt_at && op.attempt_count < op.max_attempts) {
        return { status: "accepted", operationRef: op.id, pollAfterMs: pollAfter() };
      }
      return {
        status: "failed",
        errorClass: op.retryable ? "transient" : "validation",
        code: op.error_code,
        message: (op.error_message || `Gateway operation failed${op.error_code ? ` (${op.error_code})` : ""}`).slice(0, 1000),
        final: true,
      };
    case "unknown":
    default:
      return { status: "unknown", operationRef: op.id, message: (op.error_message || "The Gateway reports the publication outcome as unknown.").slice(0, 1000) };
  }
}

export const GATEWAY_PROVIDER_ID = "agent-social-gateway";

export function createGatewayPublishingProvider(transport: GatewayPublishingTransport): PublishingProvider {
  const supported = (platform: string, kind: ContentKind) =>
    transport.available && transport.supports.some((s) => s.platform === platform && s.kinds.includes(kind));
  return {
    id: GATEWAY_PROVIDER_ID,
    platforms: GATEWAY_ACCOUNT_PLATFORMS,
    idempotentSubmit: transport.available && transport.idempotentSubmit,
    capability(platform, kind) {
      if (supported(platform, kind)) return { level: "available", reason: "Published through the Agent Social Gateway" };
      return {
        level: "unavailable",
        reason: transport.available ? `The Agent Social Gateway does not publish ${kind} to ${platform}.` : transport.unavailableReason,
      };
    },
    async submit(request: PublishRequest, signal: AbortSignal) {
      if (!supported(request.platform, request.kind)) return { status: "failed", errorClass: "unsupported_capability", message: transport.unavailableReason, final: true };
      try {
        const op = await transport.submitPublication(
          {
            idempotencyKey: request.idempotencyKey,
            accountRef: request.accountRef,
            platform: request.platform,
            kind: request.kind,
            text: request.text,
            media: request.media.map((m) => ({ url: m.url, contentType: m.contentType })),
          },
          signal,
        );
        return outcomeFromGatewayOperation(op);
      } catch (error) {
        return outcomeFromError(error, transport.idempotentSubmit);
      }
    },
    async status(operationRef: string) {
      try {
        return outcomeFromGatewayOperation(await transport.getOperation(operationRef));
      } catch (error) {
        // A failed status read never implies the publication failed: retry the poll.
        // Transient read problems keep polling; anything else (auth, 404, config) is
        // ambiguous about the publication itself and needs reconciliation.
        const o = outcomeFromError(error, true);
        if (o.status === "failed" && (o.errorClass === "transient" || o.errorClass === "internal" || o.errorClass === "rate_limited")) {
          return { status: "accepted", operationRef, pollAfterMs: o.retryAfterMs ?? 60_000 };
        }
        return { status: "unknown", operationRef, message: `Could not read the Gateway operation status: ${"message" in o ? o.message : o.status}`.slice(0, 1000) };
      }
    },
  };
}

let defaultsRegistered = false;

/** Registers the Gateway provider from server-side configuration (idempotent). */
export function registerDefaultPublishingProviders(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;
  registerPublishingProvider(createGatewayPublishingProvider(environmentGatewayPublishingTransport()));
}

/** Installs an explicit Gateway transport, primarily for tests and controlled overrides. */
export function registerGatewayPublishingTransport(transport: GatewayPublishingTransport): void {
  defaultsRegistered = true;
  registerPublishingProvider(createGatewayPublishingProvider(transport));
}

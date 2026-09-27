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
 * The Gateway is the preferred provider/action boundary. Its *operation* model
 * is known and already used by ZernFlow (`GET /v1/operations/{id}`,
 * `POST /v1/operations/{id}/retry`; fields in `GatewayOperation`). What is NOT
 * known is a Gateway endpoint that accepts a publication. Until the Gateway
 * publishes that contract, `submitPublication` is BLOCKED (EXTERNAL_CONTRACT):
 * no endpoint path or wire payload is invented here.
 *
 * The seam is deliberately narrow — one method to submit, one to read an
 * operation — so a concrete transport can be dropped in via
 * `registerGatewayPublishingTransport` without touching the engine.
 */

/**
 * ZernFlow-side description of a publication handed to the transport. This is
 * NOT a Gateway wire format; the concrete transport maps it onto whatever the
 * Gateway contract specifies once it exists.
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
  "Agent Social Gateway publishing is not available yet: the Gateway has not published a publication endpoint (external contract pending). Use manual or browser publishing.";

/** Platforms the Gateway account model knows (GatewayAccountPlatform minus "generic"). */
export const GATEWAY_ACCOUNT_PLATFORMS = ["facebook", "instagram", "telegram", "twitter", "bluesky", "reddit"] as const;

export class GatewayPublishingUnavailableError extends TaskError {
  constructor() {
    super("unsupported_capability", GATEWAY_PUBLISHING_BLOCKED_REASON);
    this.name = "GatewayPublishingUnavailableError";
  }
}

/**
 * Default transport: submission blocked (EXTERNAL_CONTRACT); operation reads
 * delegate to the existing Gateway client when one is supplied.
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

/** Registers the Gateway provider with the blocked transport (idempotent). */
export function registerDefaultPublishingProviders(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;
  registerPublishingProvider(createGatewayPublishingProvider(blockedGatewayPublishingTransport()));
}

/** Installs a concrete Gateway transport once the Gateway publishing contract exists. */
export function registerGatewayPublishingTransport(transport: GatewayPublishingTransport): void {
  defaultsRegistered = true;
  registerPublishingProvider(createGatewayPublishingProvider(transport));
}

import type { ErrorClass } from "@/lib/types/platform";
import type { EditorialDraft } from "@/lib/product/types";
import { TaskError, classifyError } from "@/lib/tasks/errors";

/**
 * Provider-neutral publishing contract (R10).
 *
 * Every API-mode publisher — a first-party provider adapter, the Agent Social
 * Gateway, or a test double — implements `PublishingProvider`. The publishing
 * engine (engine.ts) owns everything that must be identical regardless of the
 * provider: idempotency, receipts, retries, polling of accepted operations,
 * partial success and failure classification. Providers only translate one
 * request into one `PublishOutcome`.
 *
 * Nothing here is provider-specific and nothing claims a capability: a provider
 * that cannot verify a platform/kind must report `level: "unavailable"` with a
 * human-readable reason, and the engine refuses to execute it.
 */

export type ContentKind = EditorialDraft["kind"];

/** One publication request. `idempotencyKey` is stable across every retry of the same scheduled variant. */
export interface PublishRequest {
  workspaceId: string;
  variantId: string;
  channelId: string;
  /** Provider-side account handle (channels.late_account_id). */
  accountRef: string;
  platform: string;
  kind: ContentKind;
  text: string;
  /** Time-limited presigned GET URLs; providers must fetch media promptly. */
  media: { artifactId: string; contentType: string; url: string }[];
  idempotencyKey: string;
  /** 1-based attempt number (task.attempts) — informational; never part of the idempotency key. */
  attempt: number;
}

/** One part of a multi-part publication (thread, carousel fallback, …). */
export interface PublishPart {
  index: number;
  status: "published" | "failed" | "skipped";
  externalRef?: string | null;
  externalUrl?: string | null;
  message?: string | null;
}

export type PublishOutcome =
  /** The post is live. */
  | { status: "published"; externalRef: string | null; externalUrl: string | null; parts?: PublishPart[] }
  /** The provider accepted the request and will finish asynchronously; poll `status(operationRef)`. */
  | { status: "accepted"; operationRef: string; pollAfterMs?: number }
  /** Some parts are live and some are not. Never retried automatically (would duplicate the live parts). */
  | { status: "partial"; externalRef: string | null; externalUrl: string | null; parts: PublishPart[]; message: string }
  /**
   * Definitely not published. `final` means the provider already exhausted its
   * own retries (e.g. a dead-lettered Gateway operation) so ZernFlow must not resubmit.
   */
  | { status: "failed"; errorClass: ErrorClass; message: string; code?: string | null; retryAfterMs?: number; final?: boolean }
  /** The provider cannot say whether the post went live. Requires reconciliation before any resubmission. */
  | { status: "unknown"; message: string; operationRef?: string | null };

export type CapabilityLevel = "available" | "unavailable";

export interface ProviderCapability {
  level: CapabilityLevel;
  /** Shown to operators next to the API route. */
  reason: string;
}

export interface PublishingProvider {
  /** Stable id recorded on receipts and execution records (≤ 64 chars). */
  id: string;
  /** Platforms this provider knows about (used for capability reasons even when unavailable). */
  platforms: readonly string[];
  capability(platform: string, kind: ContentKind): ProviderCapability;
  /**
   * True only when resubmitting with the same idempotency key is guaranteed not
   * to create a duplicate post. Controls whether an ambiguous attempt (crash,
   * timeout) may be resubmitted automatically.
   */
  idempotentSubmit: boolean;
  submit(request: PublishRequest, signal: AbortSignal): Promise<PublishOutcome>;
  /** Required when `submit` can return `accepted`. */
  status?(operationRef: string, signal: AbortSignal): Promise<PublishOutcome>;
}

// ---------------------------------------------------------------------------
// Legacy synchronous adapter shape (kept for compatibility with R4 callers)
// ---------------------------------------------------------------------------

export type PublishPayload = Omit<PublishRequest, "variantId" | "attempt">;

export interface PublishResult {
  externalRef: string | null;
  externalUrl: string | null;
}

/** Synchronous API adapter (R4). Wrapped into a `PublishingProvider` by `providerFromApiAdapter`. */
export interface ApiPublishAdapter {
  id: string;
  platforms: readonly string[];
  kinds: readonly ContentKind[];
  publish(payload: PublishPayload, signal: AbortSignal): Promise<PublishResult>;
}

export function providerFromApiAdapter(adapter: ApiPublishAdapter): PublishingProvider {
  return {
    id: adapter.id,
    platforms: adapter.platforms,
    idempotentSubmit: false,
    capability(platform, kind) {
      return adapter.platforms.includes(platform) && adapter.kinds.includes(kind)
        ? { level: "available", reason: `Published through ${adapter.id}` }
        : { level: "unavailable", reason: `${adapter.id} does not support ${kind} on ${platform}` };
    },
    async submit(request, signal) {
      const { variantId: _v, attempt: _a, ...payload } = request;
      const r = await adapter.publish(payload, signal);
      return { status: "published", externalRef: r.externalRef, externalUrl: r.externalUrl };
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const providers: PublishingProvider[] = [];

/** Registers a provider once (by id). Later registrations with the same id replace the earlier one. */
export function registerPublishingProvider(provider: PublishingProvider): void {
  const i = providers.findIndex((p) => p.id === provider.id);
  if (i >= 0) providers[i] = provider;
  else providers.push(provider);
}

export function unregisterPublishingProvider(id: string): void {
  const i = providers.findIndex((p) => p.id === id);
  if (i >= 0) providers.splice(i, 1);
}

export function publishingProviders(): readonly PublishingProvider[] {
  return providers;
}

/** First provider (registration order) whose capability for platform/kind is `available`. */
export function apiProviderFor(platform: string, kind: ContentKind): PublishingProvider | null {
  return providers.find((p) => p.capability(platform, kind).level === "available") ?? null;
}

/** Operator-facing explanation for the API route of a platform/kind. */
export function apiRouteReason(platform: string, kind: ContentKind): { available: boolean; reason: string; providerId: string | null } {
  const provider = apiProviderFor(platform, kind);
  if (provider) return { available: true, reason: provider.capability(platform, kind).reason, providerId: provider.id };
  const claimant = providers.find((p) => p.platforms.includes(platform));
  return {
    available: false,
    reason: claimant?.capability(platform, kind).reason ?? "No API publishing provider is connected for this platform.",
    providerId: null,
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Converts an exception thrown by a provider into an outcome.
 *
 * Exceptions whose class is transient/internal (timeouts, dropped connections,
 * 5xx, unexpected bugs) are ambiguous: the provider may have received the
 * request. Unless the provider guarantees idempotent resubmission they become
 * `unknown`, which blocks automatic retries and asks an operator to check the
 * platform. Clearly pre-acceptance failures (rate limit, auth, validation,
 * policy, unsupported) keep their class.
 */
export function outcomeFromError(error: unknown, idempotentSubmit: boolean): PublishOutcome {
  const c = classifyError(error);
  if ((c.class === "transient" || c.class === "internal") && !idempotentSubmit) {
    return { status: "unknown", message: `Provider call ended ambiguously (${c.class}): ${c.message}` };
  }
  if (c.class === "unknown_outcome") return { status: "unknown", message: c.message };
  return { status: "failed", errorClass: c.class, message: c.message, ...(c.retryAfterMs ? { retryAfterMs: c.retryAfterMs } : {}), ...(c.terminal ? { final: true } : {}) };
}

/** Structural validation of an outcome returned by a (possibly third-party) provider. */
export function validateOutcome(value: unknown): PublishOutcome {
  const o = value as Partial<PublishOutcome> | null;
  const str = (x: unknown, max: number) => (typeof x === "string" && x.length > 0 && x.length <= max ? x : null);
  if (!o || typeof o !== "object") throw new TaskError("unknown_outcome", "Provider returned no outcome");
  switch (o.status) {
    case "published":
      return { status: "published", externalRef: str(o.externalRef, 300), externalUrl: httpsOrNull(o.externalUrl), ...(Array.isArray(o.parts) ? { parts: sanitizeParts(o.parts) } : {}) };
    case "accepted": {
      const ref = str(o.operationRef, 300);
      if (!ref) throw new TaskError("unknown_outcome", "Provider accepted the publication without an operation reference");
      const poll = typeof o.pollAfterMs === "number" && Number.isFinite(o.pollAfterMs) ? o.pollAfterMs : undefined;
      return { status: "accepted", operationRef: ref, ...(poll !== undefined ? { pollAfterMs: poll } : {}) };
    }
    case "partial":
      return {
        status: "partial",
        externalRef: str(o.externalRef, 300),
        externalUrl: httpsOrNull(o.externalUrl),
        parts: sanitizeParts(Array.isArray(o.parts) ? o.parts : []),
        message: str(o.message, 1000) ?? "Only part of the publication went live",
      };
    case "failed": {
      const f = o as Extract<PublishOutcome, { status: "failed" }>;
      const known = ["transient", "rate_limited", "auth_expired", "reauth_required", "human_challenge", "unsupported_capability", "validation", "policy_denied", "unknown_outcome", "internal"];
      const cls: ErrorClass = known.includes(f.errorClass as string) ? f.errorClass : "internal";
      if (cls === "unknown_outcome") return { status: "unknown", message: str(f.message, 1000) ?? "Outcome unknown" };
      return {
        status: "failed",
        errorClass: cls,
        message: str(f.message, 1000) ?? "Publishing failed",
        code: str(f.code, 100),
        ...(typeof f.retryAfterMs === "number" && f.retryAfterMs > 0 ? { retryAfterMs: Math.min(f.retryAfterMs, 6 * 3600_000) } : {}),
        ...(f.final ? { final: true } : {}),
      };
    }
    case "unknown":
      return { status: "unknown", message: str(o.message, 1000) ?? "Outcome unknown", operationRef: str((o as { operationRef?: unknown }).operationRef, 300) };
    default:
      throw new TaskError("unknown_outcome", "Provider returned an unrecognised outcome");
  }
}

function sanitizeParts(parts: unknown[]): PublishPart[] {
  return parts.slice(0, 50).flatMap((p, i) => {
    const x = p as Partial<PublishPart> | null;
    if (!x || typeof x !== "object" || !["published", "failed", "skipped"].includes(x.status as string)) return [];
    return [{
      index: typeof x.index === "number" && Number.isInteger(x.index) ? x.index : i,
      status: x.status as PublishPart["status"],
      externalRef: typeof x.externalRef === "string" ? x.externalRef.slice(0, 300) : null,
      externalUrl: httpsOrNull(x.externalUrl),
      message: typeof x.message === "string" ? x.message.slice(0, 300) : null,
    }];
  });
}

export function httpsOrNull(u: unknown): string | null {
  return typeof u === "string" && u.startsWith("https://") && u.length <= 2000 ? u : null;
}

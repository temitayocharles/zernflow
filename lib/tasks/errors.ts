import type { ErrorClass, RetryDecision } from "@/lib/types/platform";
import { SocialGatewayConfigurationError, SocialGatewayError } from "@/lib/social-gateway/client";
import { SafeFetchError, UnsafeUrlError } from "@/lib/security/safe-fetch";
import { redactString } from "@/lib/observability/log";

/** Errors thrown by task handlers/adapters with an explicit classification. */
export class TaskError extends Error {
  constructor(
    readonly errorClass: ErrorClass,
    message: string,
    /**
     * terminal: the handler has already applied its final side effects and
     * the task must not be retried regardless of class (dead-letter now).
     */
    readonly options: { retryAfterMs?: number; cause?: unknown; terminal?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "TaskError";
  }
}

export interface ClassifiedError {
  class: ErrorClass;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  terminal?: boolean;
}

export const ERROR_CLASSES: readonly ErrorClass[] = [
  "transient",
  "rate_limited",
  "auth_expired",
  "reauth_required",
  "human_challenge",
  "unsupported_capability",
  "validation",
  "policy_denied",
  "unknown_outcome",
  "internal",
];

/** Retry decision per error class (EXECUTION_MODEL.md §4). Never retries human challenges. */
export function decisionFor(errorClass: ErrorClass): Exclude<RetryDecision, "none"> {
  switch (errorClass) {
    case "transient":
    case "rate_limited":
    case "internal":
      return "retry";
    case "auth_expired":
    case "reauth_required":
    case "human_challenge":
    case "unsupported_capability":
    case "unknown_outcome":
      return "needs_user";
    case "validation":
    case "policy_denied":
      return "give_up";
  }
}

export function classifyError(error: unknown): ClassifiedError {
  const make = (cls: ErrorClass, message: string, retryAfterMs?: number): ClassifiedError => ({
    class: cls,
    message: redactString(message).slice(0, 1000),
    retryable: decisionFor(cls) === "retry",
    ...(retryAfterMs ? { retryAfterMs } : {}),
  });
  if (error instanceof TaskError) {
    const classified = make(error.errorClass, error.message, error.options.retryAfterMs);
    return error.options.terminal ? { ...classified, retryable: false, terminal: true } : classified;
  }
  if (error instanceof SocialGatewayConfigurationError) return make("policy_denied", error.message);
  if (error instanceof SocialGatewayError) {
    if (error.status === 429) return make("rate_limited", error.message);
    if (error.status === 401 || error.status === 403) return make("auth_expired", error.message);
    if (error.retryable || (error.status !== null && error.status >= 500)) return make("transient", error.message);
    if (error.status !== null && error.status >= 400) return make("validation", error.message);
    return make("transient", error.message);
  }
  if (error instanceof UnsafeUrlError) return make("policy_denied", error.message);
  if (error instanceof SafeFetchError) {
    return error.code === "too_large" ? make("validation", error.message) : make("transient", error.message);
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return make("transient", error.message);
  }
  return make("internal", error instanceof Error ? error.message : "Unexpected failure");
}

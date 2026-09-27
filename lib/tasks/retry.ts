export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 30_000, maxDelayMs: 3_600_000 };

export function normalizeRetryPolicy(value: unknown): RetryPolicy {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const num = (x: unknown, fallback: number, min: number, max: number) =>
    typeof x === "number" && Number.isFinite(x) ? Math.min(max, Math.max(min, Math.floor(x))) : fallback;
  return {
    maxAttempts: num(v.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts, 1, 20),
    baseDelayMs: num(v.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs, 1_000, 3_600_000),
    maxDelayMs: num(v.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs, 1_000, 86_400_000),
  };
}

/** Exponential backoff with ±20% jitter: min(base·2^(attempt-1), max). */
export function computeRetryDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exp = Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempt - 1), policy.maxDelayMs);
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.max(1_000, Math.round(exp * jitter));
}

import { describe, expect, it } from "vitest";
import { computeRetryDelay, DEFAULT_RETRY_POLICY, normalizeRetryPolicy } from "./retry";
import { classifyError, decisionFor, TaskError } from "./errors";
import { SocialGatewayError } from "@/lib/social-gateway/client";
import { UnsafeUrlError } from "@/lib/security/safe-fetch";

describe("retry policy", () => {
  it("backs off exponentially with bounded jitter and a cap", () => {
    const mid = () => 0.5;
    expect(computeRetryDelay(1, DEFAULT_RETRY_POLICY, mid)).toBe(30_000);
    expect(computeRetryDelay(3, DEFAULT_RETRY_POLICY, mid)).toBe(120_000);
    expect(computeRetryDelay(20, DEFAULT_RETRY_POLICY, mid)).toBe(3_600_000);
    expect(computeRetryDelay(1, DEFAULT_RETRY_POLICY, () => 0)).toBe(24_000);
    expect(computeRetryDelay(1, DEFAULT_RETRY_POLICY, () => 0.999)).toBeLessThanOrEqual(36_000);
  });
  it("normalizes untrusted policies", () => {
    expect(normalizeRetryPolicy({ maxAttempts: 999, baseDelayMs: 1 })).toEqual({
      maxAttempts: 20,
      baseDelayMs: 1000,
      maxDelayMs: 3_600_000,
    });
  });
});

describe("error taxonomy", () => {
  it("never retries human challenges or re-auth; gives up on policy", () => {
    expect(decisionFor("human_challenge")).toBe("needs_user");
    expect(decisionFor("reauth_required")).toBe("needs_user");
    expect(decisionFor("unknown_outcome")).toBe("needs_user");
    expect(decisionFor("policy_denied")).toBe("give_up");
    expect(decisionFor("rate_limited")).toBe("retry");
  });
  it("classifies Gateway, SSRF and generic errors", () => {
    expect(classifyError(new SocialGatewayError("x", "slow down", { status: 429 })).class).toBe("rate_limited");
    expect(classifyError(new SocialGatewayError("x", "expired", { status: 401 })).class).toBe("auth_expired");
    expect(classifyError(new SocialGatewayError("x", "bad", { status: 422 })).class).toBe("validation");
    expect(classifyError(new SocialGatewayError("x", "down", { status: 503 })).class).toBe("transient");
    expect(classifyError(new UnsafeUrlError("private")).class).toBe("policy_denied");
    expect(classifyError(new TaskError("human_challenge", "captcha")).class).toBe("human_challenge");
    expect(classifyError(new Error("boom")).class).toBe("internal");
  });
  it("redacts secrets from error messages", () => {
    const c = classifyError(new Error("failed with Bearer abcdefghijklmnopqrstuvwxyz0123"));
    expect(c.message).not.toContain("abcdefghijklmnop");
  });
});

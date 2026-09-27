import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedCronRequest } from "./cron-auth";

const secret = "a-cron-secret-with-at-least-24-chars";
afterEach(() => vi.unstubAllEnvs());

describe("isAuthorizedCronRequest", () => {
  it("accepts only a matching bearer header", () => {
    vi.stubEnv("CRON_SECRET", secret);
    expect(isAuthorizedCronRequest(new Headers({ authorization: `Bearer ${secret}` }))).toBe(true);
    expect(isAuthorizedCronRequest(new Headers({ authorization: `Bearer ${secret}x` }))).toBe(false);
    expect(isAuthorizedCronRequest(new Headers({ authorization: secret }))).toBe(false);
    expect(isAuthorizedCronRequest(new Headers())).toBe(false);
  });
  it("fails closed when the secret is missing or weak", () => {
    vi.stubEnv("CRON_SECRET", "short");
    expect(isAuthorizedCronRequest(new Headers({ authorization: "Bearer short" }))).toBe(false);
    vi.stubEnv("CRON_SECRET", "");
    expect(isAuthorizedCronRequest(new Headers({ authorization: "Bearer " }))).toBe(false);
  });
});

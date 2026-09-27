import { describe, expect, it } from "vitest";
import { generateWorkerToken, hashWorkerToken, hashesEqual, parseBearerWorkerToken } from "./tokens";

describe("worker tokens", () => {
  it("issues high-entropy tokens stored only as SHA-256", () => {
    const a = generateWorkerToken();
    const b = generateWorkerToken();
    expect(a.token).toMatch(/^zfw_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(hashWorkerToken(a.token));
    expect(a.prefix).toBe(a.token.slice(0, 12));
    expect(hashesEqual(a.hash, hashWorkerToken(a.token))).toBe(true);
    expect(hashesEqual(a.hash, b.hash)).toBe(false);
  });
  it("accepts only well-formed bearer tokens", () => {
    const { token } = generateWorkerToken();
    expect(parseBearerWorkerToken(`Bearer ${token}`)).toBe(token);
    expect(parseBearerWorkerToken(token)).toBeNull();
    expect(parseBearerWorkerToken("Bearer zfw_short")).toBeNull();
    expect(parseBearerWorkerToken(null)).toBeNull();
  });
});

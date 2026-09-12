import { describe, expect, it } from "vitest";
import { smokeConfig } from "./smoke-config.mjs";
const env = {
  SMOKE_ALLOW_WRITES: "disposable-environment-only",
  SMOKE_BASE_URL: "https://test.example.com",
  SMOKE_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
  SMOKE_CHANNEL_ID: "22222222-2222-4222-8222-222222222222",
  SMOKE_ACCOUNT_ID: "test-account",
  NEXT_PUBLIC_SUPABASE_URL: "https://db.example.com",
  SUPABASE_SERVICE_ROLE_KEY: "test-only",
};
describe("destructive smoke configuration", () => {
  it("has no implicit remote target", () => {
    expect(() => smokeConfig({}, undefined)).toThrow("SMOKE_ALLOW_WRITES");
    expect(() => smokeConfig({ ...env, SMOKE_BASE_URL: "" }, undefined)).toThrow("SMOKE_BASE_URL");
  });
  it.each(Object.keys(env))("requires explicit %s", (key) => {
    expect(() => smokeConfig({ ...env, [key]: "" }, undefined)).toThrow();
  });
  it.each(["ftp://test.example.com", "http://test.example.com", "https://user:pass@test.example.com", "https://test.example.com/path", "https://test.example.com/?secret=x"])("rejects unsafe target %s", (url) => {
    expect(() => smokeConfig(env, url)).toThrow();
  });
  it("validates tenant identifiers", () => {
    expect(() => smokeConfig({ ...env, SMOKE_WORKSPACE_ID: "bad" }, undefined)).toThrow("UUID");
  });
  it("accepts explicit isolated HTTPS and loopback origins", () => {
    expect(smokeConfig(env, undefined).baseUrl).toBe(env.SMOKE_BASE_URL);
    expect(smokeConfig(env, "http://localhost:3000").baseUrl).toBe("http://localhost:3000");
  });
});

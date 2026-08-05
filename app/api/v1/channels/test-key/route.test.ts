import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("POST /api/v1/channels/test-key", () => {
  it("retires browser-managed credentials without exposing secret fields", async () => {
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(response.headers.get("Deprecation")).toBe("true");
    expect(response.headers.get("Link")).toContain("/api/v1/channels/sync");
    expect(body).toMatchObject({
      code: "browser_managed_credentials_retired",
      replacement: "/api/v1/channels/sync",
    });
    expect(Object.keys(body)).not.toEqual(
      expect.arrayContaining(["token", "secret", "apiKey", "credential"]),
    );
  });
});

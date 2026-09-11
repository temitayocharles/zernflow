import { describe, expect, it } from "vitest";
import { readJson, failure, ApiError } from "./api";
describe("product request boundaries", () => {
  it("bounds bodies before parsing and does not trust content length", async () => {
    const request = new Request("https://app.example", {
      method: "POST",
      headers: { "Content-Length": "1" },
      body: "x".repeat(50),
    });
    await expect(readJson(request, 10)).rejects.toBeInstanceOf(ApiError);
  });
  it("parses bounded JSON and rejects empty requests", async () => {
    expect(
      await readJson(
        new Request("https://app.example", {
          method: "POST",
          body: '{"name":"X"}',
        }),
      ),
    ).toEqual({ name: "X" });
    await expect(
      readJson(new Request("https://app.example")),
    ).rejects.toThrow();
  });
  it("never reflects raw parser input or unexpected upstream errors", async () => {
    expect(await failure(new SyntaxError("sensitive input")).json()).toEqual({
      error: "Invalid JSON body",
    });
    expect(await failure(new Error("secret upstream failure")).json()).toEqual({
      error: "Unable to complete the request",
    });
  });
});

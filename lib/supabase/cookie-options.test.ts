import { describe, expect, it } from "vitest";
import { getSupabaseCookieOptions } from "./cookie-options";

describe("getSupabaseCookieOptions", () => {
  it("marks production auth cookies Secure", () => {
    expect(getSupabaseCookieOptions("production")).toMatchObject({
      secure: true,
      sameSite: "lax",
      path: "/",
      httpOnly: false,
    });
  });

  it("allows local HTTP development without weakening production", () => {
    expect(getSupabaseCookieOptions("development").secure).toBe(false);
  });
});

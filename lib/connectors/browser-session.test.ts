import { describe, expect, it } from "vitest";
import {
  browserCanPerform,
  browserSessionPresentation,
  type BrowserSessionProjection,
} from "./browser-session";
const session: BrowserSessionProjection = {
  connectorRef: "c",
  status: "healthy",
  capabilities: { reply: true },
  lastSuccessfulOperationAt: null,
  expiresAt: null,
  permittedUseConfirmed: true,
};
describe("safe browser connector state", () => {
  it.each([
    "mfa_required",
    "human_login_required",
    "challenge_required",
    "expired",
    "revoked",
    "degraded",
  ] as const)("cannot execute in %s", (status) => {
    expect(browserCanPerform({ ...session, status }, "reply")).toBe(false);
  });
  it("requires permission and explicit capability", () => {
    expect(
      browserCanPerform({ ...session, permittedUseConfirmed: false }, "reply"),
    ).toBe(false);
    expect(browserCanPerform(session, "unknown")).toBe(false);
    expect(browserCanPerform(session, "reply")).toBe(true);
  });
  it("never bypasses a human challenge", () => {
    expect(
      browserSessionPresentation({ ...session, status: "challenge_required" }),
    ).toMatchObject({ requiresHuman: true, canExecute: false });
  });
});
it("reports an expired deadline even if upstream health is stale", () => {
  expect(
    browserSessionPresentation(
      { ...session, expiresAt: "2026-09-01T00:00:00Z" },
      Date.parse("2026-09-11T00:00:00Z"),
    ),
  ).toMatchObject({
    canExecute: false,
    reconnectRequired: true,
    label: "Session expired; reconnect",
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  createZernioClient,
  isLegacyZernioEnabled,
  LegacyZernioDisabledError,
} from "./zernio-client";

const originalFlag = process.env.ENABLE_LEGACY_ZERNIO;

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env.ENABLE_LEGACY_ZERNIO;
  } else {
    process.env.ENABLE_LEGACY_ZERNIO = originalFlag;
  }
});

describe("legacy Zernio quarantine", () => {
  it("is disabled by default", () => {
    delete process.env.ENABLE_LEGACY_ZERNIO;
    expect(isLegacyZernioEnabled()).toBe(false);
    expect(() =>
      createZernioClient("legacy-api-key-with-at-least-24-characters"),
    ).toThrow(LegacyZernioDisabledError);
  });

  it("requires the exact explicit migration flag", () => {
    process.env.ENABLE_LEGACY_ZERNIO = "TRUE";
    expect(isLegacyZernioEnabled()).toBe(false);

    process.env.ENABLE_LEGACY_ZERNIO = "true";
    expect(isLegacyZernioEnabled()).toBe(true);
  });

  it("rejects weak keys even when migration mode is enabled", () => {
    process.env.ENABLE_LEGACY_ZERNIO = "true";
    expect(() => createZernioClient("short-key")).toThrow(
      "Legacy Zernio API key must contain at least 24 characters",
    );
  });
});

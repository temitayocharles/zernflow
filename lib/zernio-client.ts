/**
 * Legacy Zernio API client.
 *
 * This adapter exists only while remaining hosted-Zernio routes are migrated to
 * Agent Social Gateway. It is disabled by default and requires an explicit
 * server-side migration flag. Never expose this flag or API key to the browser.
 */

import Zernio from "@zernio/node";

export type { Zernio };

export class LegacyZernioDisabledError extends Error {
  readonly code = "legacy_zernio_disabled";

  constructor() {
    super(
      "Legacy Zernio integration is disabled. Migrate this operation to Agent Social Gateway or explicitly enable bounded migration mode.",
    );
    this.name = "LegacyZernioDisabledError";
  }
}

export function isLegacyZernioEnabled(): boolean {
  return process.env.ENABLE_LEGACY_ZERNIO === "true";
}

export function createZernioClient(apiKey: string): Zernio {
  if (!isLegacyZernioEnabled()) {
    throw new LegacyZernioDisabledError();
  }

  const normalizedKey = apiKey.trim();
  if (normalizedKey.length < 24) {
    throw new Error("Legacy Zernio API key must contain at least 24 characters");
  }

  return new Zernio({ apiKey: normalizedKey });
}

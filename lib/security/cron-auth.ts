import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Scheduler authentication for /api/cron/*. The secret is accepted only in the
 * Authorization header (middleware maps legacy `x-cron-secret`). Query-string
 * secrets are refused because they leak into proxy/access logs.
 * Comparison is constant-time over SHA-256 digests (length independent).
 */
export function isAuthorizedCronRequest(headers: Headers): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected || expected.length < 24) return false;
  const header = headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const provided = createHash("sha256").update(match[1]).digest();
  const wanted = createHash("sha256").update(expected).digest();
  return timingSafeEqual(provided, wanted);
}

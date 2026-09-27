import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Worker tokens: `zfw_` + 32 random bytes (base64url). Only the SHA-256 is stored. */
export function generateWorkerToken(): { token: string; hash: string; prefix: string } {
  const token = `zfw_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashWorkerToken(token), prefix: token.slice(0, 12) };
}

export function hashWorkerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function parseBearerWorkerToken(header: string | null): string | null {
  const match = /^Bearer\s+(zfw_[A-Za-z0-9_-]{40,60})$/.exec(header?.trim() ?? "");
  return match ? match[1] : null;
}

export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function workerLeaseOwner(identityId: string): string {
  return `worker:${identityId}`;
}

import type { BrowserAdapter } from "./contract";

/**
 * Validation of an imported Playwright storage state (cookies + localStorage).
 * Only domains belonging to the adapter's platform are accepted, so a session
 * secret can never carry cookies for unrelated sites. Values are never
 * returned; only a summary.
 */
export const MAX_STORAGE_STATE_BYTES = 60 * 1024;

export interface StorageStateSummary {
  cookieCount: number;
  originCount: number;
  authCookiesPresent: boolean;
  /** Earliest expiry among the auth cookies (ISO) — the session cannot outlive it. */
  expiresAt: string | null;
}

export class StorageStateError extends Error {}

function domainAllowed(domain: string, allowed: readonly string[]): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  return allowed.some((a) => d === a || d.endsWith(`.${a}`));
}

export function parseStorageState(raw: string, adapter: BrowserAdapter): { normalized: string; summary: StorageStateSummary } {
  if (Buffer.byteLength(raw, "utf8") > MAX_STORAGE_STATE_BYTES) throw new StorageStateError(`Session file is larger than ${MAX_STORAGE_STATE_BYTES / 1024} KB. Export only the platform's site.`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new StorageStateError("Session file is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StorageStateError("Session file must be a Playwright storage state object.");
  const v = value as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(v.cookies)) throw new StorageStateError("Session file has no cookies array.");
  const origins = v.origins === undefined ? [] : v.origins;
  if (!Array.isArray(origins)) throw new StorageStateError("origins must be an array.");

  const cookies = v.cookies.map((c, i) => {
    if (!c || typeof c !== "object") throw new StorageStateError(`Cookie ${i + 1} is invalid.`);
    const k = c as Record<string, unknown>;
    if (typeof k.name !== "string" || typeof k.value !== "string" || typeof k.domain !== "string") throw new StorageStateError(`Cookie ${i + 1} needs name, value and domain.`);
    if (!domainAllowed(k.domain, adapter.storageDomains)) throw new StorageStateError(`Cookie for ${k.domain} does not belong to ${adapter.label}. Export only ${adapter.storageDomains.join(", ")}.`);
    const sameSite = k.sameSite === "Strict" || k.sameSite === "Lax" || k.sameSite === "None" ? k.sameSite : "Lax";
    return {
      name: k.name, value: k.value, domain: k.domain, path: typeof k.path === "string" ? k.path : "/",
      expires: typeof k.expires === "number" ? k.expires : -1, httpOnly: k.httpOnly === true, secure: k.secure !== false, sameSite,
    };
  });
  const normalizedOrigins = origins.map((o, i) => {
    const r = o as { origin?: unknown; localStorage?: unknown };
    if (typeof r?.origin !== "string") throw new StorageStateError(`Origin ${i + 1} is invalid.`);
    let host: string;
    try {
      const u = new URL(r.origin);
      if (u.protocol !== "https:") throw new Error();
      host = u.hostname;
    } catch {
      throw new StorageStateError(`Origin ${r.origin} must be an https origin.`);
    }
    if (!domainAllowed(host, adapter.storageDomains)) throw new StorageStateError(`Origin ${r.origin} does not belong to ${adapter.label}.`);
    const ls = Array.isArray(r.localStorage) ? r.localStorage : [];
    return {
      origin: r.origin,
      localStorage: ls
        .filter((e): e is { name: string; value: string } => !!e && typeof e.name === "string" && typeof e.value === "string")
        .map((e) => ({ name: e.name, value: e.value })),
    };
  });

  const { authCookies, cookieDomain } = adapter.signals;
  const auth = cookies.filter((c) => authCookies.includes(c.name) && domainAllowed(c.domain, [cookieDomain]));
  const authCookiesPresent = authCookies.every((n) => auth.some((c) => c.name === n));
  const expiries = auth.map((c) => c.expires).filter((e) => e > 0);
  const expiresAt = expiries.length ? new Date(Math.min(...expiries) * 1000).toISOString() : null;
  return {
    normalized: JSON.stringify({ cookies, origins: normalizedOrigins }),
    summary: { cookieCount: cookies.length, originCount: normalizedOrigins.length, authCookiesPresent, expiresAt },
  };
}

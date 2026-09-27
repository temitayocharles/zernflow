/**
 * Request guard for the browser runtime: blocks non-web schemes and private,
 * loopback, link-local and metadata addresses so a page cannot pivot into the
 * executor's network. (Hostname-level: DNS-rebinding to private ranges is
 * mitigated by running the executor without access to internal services.)
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "data:", "blob:"]);

function ipv4Private(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

function ipv6Private(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return ipv4Private(mapped[1]);
  // WHATWG URL normalises ::ffff:127.0.0.1 to ::ffff:7f00:1 — decode the hex form too.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // IPv4-compatible (deprecated) ::a.b.c.d / ::XXXX:XXXX forms.
  const compat = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (compat) {
    const hi = parseInt(compat[1], 16);
    const lo = parseInt(compat[2], 16);
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

export function isBlockedRequest(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) return true;
  if (u.protocol === "data:" || u.protocol === "blob:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "metadata.google.internal") return true;
  return ipv4Private(host) || ipv6Private(host);
}

/** Top-level navigation allowlist: exact host or subdomain of an allowed host, https only. */
export function isAllowedNavigation(url: string, allowedHosts: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

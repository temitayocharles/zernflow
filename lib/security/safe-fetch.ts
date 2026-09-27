import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/**
 * SSRF-resistant outbound HTTP for user-configured URLs (flow HTTP nodes,
 * outbound webhooks, any operator-supplied endpoint).
 *
 * - http/https only, no URL credentials, no redirects followed;
 * - every resolved address is validated *at connect time* through a custom
 *   `lookup`, which also defeats DNS rebinding between check and connect;
 * - loopback, private, link-local (cloud metadata), CGNAT, multicast,
 *   documentation and reserved ranges are refused (IPv4 + IPv6 + mapped);
 * - bounded time and response size; hop-by-hop/host headers are dropped.
 *
 * Self-hosted operators may explicitly allow internal hosts with
 * SAFE_FETCH_ALLOW_HOSTS (comma-separated exact hostnames).
 */

export class UnsafeUrlError extends Error {
  readonly code = "unsafe_url";
}
export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly code: "timeout" | "too_large" | "network",
  ) {
    super(message);
  }
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Test seam; production uses node:dns. */
  resolver?: (hostname: string) => Promise<LookupAddress[]>;
}

export interface SafeFetchResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

const FORBIDDEN_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization",
  "proxy-connection", "keep-alive", "te", "trailer",
]);

function ipv4ToInt(address: string): number {
  return address.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function expandIpv6(address: string): number[] | null {
  let input = address.toLowerCase().split("%")[0];
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  const v4 = input.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    input = input.replace(v4[1], `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head, tail] = input.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  if (input.includes("::")) {
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    return [...headParts, ...Array(missing).fill("0"), ...tailParts].map((p) => parseInt(p, 16));
  }
  return headParts.length === 8 ? headParts.map((p) => parseInt(p, 16)) : null;
}

function isBlockedIpv6(address: string): boolean {
  const parts = expandIpv6(address);
  if (!parts || parts.some((p) => Number.isNaN(p))) return true;
  const allZeroPrefix = parts.slice(0, 5).every((p) => p === 0);
  if (allZeroPrefix && parts[5] === 0xffff) {
    // IPv4-mapped
    return isBlockedIpv4(`${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`);
  }
  if (parts.every((p) => p === 0)) return true; // ::
  if (parts.slice(0, 7).every((p) => p === 0) && parts[7] === 1) return true; // ::1
  if ((parts[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((parts[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((parts[0] & 0xff00) === 0xff00) return true; // multicast
  if (parts[0] === 0x2001 && parts[1] === 0x0db8) return true; // documentation
  if (parts[0] === 0x0064 && parts[1] === 0xff9b) {
    // NAT64 embeds IPv4
    return isBlockedIpv4(`${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`);
  }
  if (allZeroPrefix && parts[5] === 0) return true; // deprecated IPv4-compatible
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function allowedHosts(): Set<string> {
  return new Set(
    (process.env.SAFE_FETCH_ALLOW_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("Only http and https URLs are allowed");
  }
  if (url.username || url.password) throw new UnsafeUrlError("URL credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new UnsafeUrlError("URL host is required");
  if (allowedHosts().has(host)) return url;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new UnsafeUrlError("Internal hostnames are not allowed");
  }
  if (isIP(host) && isBlockedAddress(host)) throw new UnsafeUrlError("Destination address is not allowed");
  return url;
}

function guardedLookup(
  hostname: string,
  resolver: SafeFetchOptions["resolver"],
): LookupFunction {
  const allow = allowedHosts().has(hostname.toLowerCase());
  return ((host: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const done = (error: Error | null, addresses?: LookupAddress[]) => {
      if (error || !addresses?.length) return callback(error ?? new UnsafeUrlError("Host did not resolve"));
      const blocked = addresses.find((a) => isBlockedAddress(a.address));
      if (blocked && !allow) return callback(new UnsafeUrlError("Destination address is not allowed"));
      const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
      if (wantsAll) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    };
    if (resolver) resolver(host).then((a) => done(null, a), (e: Error) => done(e));
    else dnsLookup(host, { all: true, verbatim: true }, (e, a) => done(e, a as LookupAddress[]));
  }) as LookupFunction;
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const url = assertSafeUrl(rawUrl);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 100), 30_000);
  const maxBytes = Math.min(Math.max(options.maxResponseBytes ?? 1_048_576, 1), 10_485_760);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (!FORBIDDEN_HEADERS.has(key.toLowerCase()) && typeof value === "string") headers[key] = value;
  }
  const body = options.body;
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<SafeFetchResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: SafeFetchResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(
          error instanceof UnsafeUrlError || error instanceof SafeFetchError
            ? error
            : new SafeFetchError("Network request failed", "network"),
        );
      } else resolve(value as SafeFetchResponse);
    };
    const req = requester(
      url,
      {
        method: (options.method ?? "GET").toUpperCase(),
        headers,
        lookup: guardedLookup(url.hostname, options.resolver),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new SafeFetchError("Response exceeds the configured size limit", "too_large"));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(null, { status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", (error) => finish(error));
      },
    );
    const timer = setTimeout(() => {
      finish(new SafeFetchError("Request timed out", "timeout"));
      req.destroy();
    }, timeoutMs);
    req.on("timeout", () => {
      finish(new SafeFetchError("Request timed out", "timeout"));
      req.destroy();
    });
    req.on("error", (error) => finish(error));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

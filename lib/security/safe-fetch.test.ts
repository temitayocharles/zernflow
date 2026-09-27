import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertSafeUrl, isBlockedAddress, safeFetch, UnsafeUrlError } from "./safe-fetch";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1",
    "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2001:db8::1", "not-an-ip",
  ])("blocks %s", (address) => expect(isBlockedAddress(address)).toBe(true));
  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"])("allows %s", (address) =>
    expect(isBlockedAddress(address)).toBe(false),
  );
});

describe("assertSafeUrl", () => {
  it.each([
    "file:///etc/passwd", "gopher://x", "http://user:pass@example.com", "http://localhost:3000",
    "http://metadata.google.internal/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "not a url",
  ])("rejects %s", (url) => expect(() => assertSafeUrl(url)).toThrow(UnsafeUrlError));
  it("accepts public https", () => expect(assertSafeUrl("https://example.com/hook").hostname).toBe("example.com"));
});

describe("safeFetch", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/" });
        return res.end();
      }
      if (req.url === "/big") return res.end("x".repeat(5000));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  afterEach(() => vi.unstubAllEnvs());

  it("refuses hostnames that resolve to private addresses (DNS rebinding safe)", async () => {
    await expect(
      safeFetch(`http://rebind.example:${port}/`, {
        resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("performs requests to explicitly allowed hosts, without following redirects, bounded in size", async () => {
    vi.stubEnv("SAFE_FETCH_ALLOW_HOSTS", "allowed.test");
    const resolver = async () => [{ address: "127.0.0.1", family: 4 }];
    const ok = await safeFetch(`http://allowed.test:${port}/`, { resolver, headers: { Host: "evil" } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text).host).toBe(`allowed.test:${port}`);
    const redirect = await safeFetch(`http://allowed.test:${port}/redirect`, { resolver });
    expect(redirect.status).toBe(302);
    await expect(safeFetch(`http://allowed.test:${port}/big`, { resolver, maxResponseBytes: 100 })).rejects.toThrow(
      /size limit/,
    );
  });
});

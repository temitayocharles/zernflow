import { describe, expect, it, vi } from "vitest";
import { validateBaseUrl, WorkerApiError, WorkerClient } from "./client";

const TOKEN = `zfw_${"a".repeat(43)}`;
const jsonRes = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("worker client", () => {
  it("refuses plain http except localhost, and URLs carrying credentials", () => {
    expect(() => validateBaseUrl("http://zernflow.example")).toThrow(/https/);
    expect(() => validateBaseUrl("https://user:pw@zernflow.example")).toThrow(/credentials/);
    expect(() => validateBaseUrl("ftp://x")).toThrow();
    expect(validateBaseUrl("http://localhost:3000").host).toBe("localhost:3000");
    expect(() => new WorkerClient({ baseUrl: "https://z.example", token: "nope" })).toThrow(/TOKEN/);
  });

  it("sends the bearer token only to the control plane, never following redirects", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/artifacts")) return jsonRes(201, { artifactId: "a1", upload: { url: "https://bucket.example/put?sig=1", method: "PUT", headers: { "Content-Type": "image/png" } } });
      if (url.startsWith("https://bucket.example")) return new Response(null, { status: 200 });
      return jsonRes(200, { artifactId: "a1", status: "available" });
    });
    const client = new WorkerClient({ baseUrl: "https://z.example/ignored-path", token: TOKEN, fetch });
    const id = await client.uploadArtifact("t1", { kind: "screenshot", fileName: "s.png", contentType: "image/png", bytes: new Uint8Array([1, 2]), sha256: "0".repeat(64) });
    expect(id).toBe("a1");
    expect(calls.map((c) => c.url)).toEqual([
      "https://z.example/api/worker/v1/tasks/t1/artifacts",
      "https://bucket.example/put?sig=1",
      "https://z.example/api/worker/v1/tasks/t1/artifacts/a1/complete",
    ]);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(calls[1].init.headers)).not.toContain(TOKEN);
    expect(calls.every((c) => c.init.redirect === "error")).toBe(true);
  });

  it("maps 204 to idle and surfaces API errors with their code", async () => {
    const client = new WorkerClient({ baseUrl: "https://z.example", token: TOKEN, fetch: async () => new Response(null, { status: 204 }) });
    expect(await client.claim({ modes: ["browser"], capabilities: { adapters: [] }, version: "0" })).toBeNull();
    const failing = new WorkerClient({ baseUrl: "https://z.example", token: TOKEN, fetch: async () => jsonRes(409, { code: "lease_lost", error: "Lease not held" }) });
    await expect(failing.heartbeat("t1")).rejects.toMatchObject({ status: 409, code: "lease_lost" });
    await expect(failing.heartbeat("t1")).rejects.toBeInstanceOf(WorkerApiError);
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readBudget } from "@/lib/runtime/budget";
import { MemoryObjectStore } from "@/lib/storage/memory";
import { createMemorySupabase } from "@/lib/test/memory-supabase";
import { contentDisposition, magicMatches, mimeAllowed, sanitizeFileName, USER_UPLOAD_KINDS, WORKER_UPLOAD_KINDS } from "./policy";
import { completeUpload, createUpload, deleteArtifact, signedDownload, sweepArtifacts, objectKeyFor } from "./service";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const user = { type: "user" as const, id: "u1" };

function setup(env: Record<string, string> = {}) {
  const db = createMemorySupabase({ artifacts: [] }, { defaults: { artifacts: () => ({ metadata: {}, completed_at: null }) } });
  const store = new MemoryObjectStore();
  return { db, client: db.client as never, store, budget: readBudget(env) };
}

describe("artifact policy", () => {
  it("allowlists MIME types per kind and rejects active content", () => {
    expect(mimeAllowed("image", "image/png")).toBe(true);
    expect(mimeAllowed("image", "image/svg+xml")).toBe(false);
    expect(mimeAllowed("document", "text/html")).toBe(false);
    expect(mimeAllowed("image", "IMAGE/PNG; charset=binary")).toBe(true);
    expect(USER_UPLOAD_KINDS).not.toContain("trace");
    expect(WORKER_UPLOAD_KINDS).toContain("screenshot");
  });

  it("sniffs magic bytes and refuses markup disguised as text", () => {
    expect(magicMatches("image/png", PNG)).toBe(true);
    expect(magicMatches("image/jpeg", PNG)).toBe(false);
    expect(magicMatches("application/json", new TextEncoder().encode('{"a":1}'))).toBe(true);
    expect(magicMatches("text/plain", new TextEncoder().encode("<!DOCTYPE html><script>"))).toBe(false);
    expect(magicMatches("text/csv", new Uint8Array([0x61, 0, 0x62]))).toBe(false);
    expect(magicMatches("application/pdf", new TextEncoder().encode("%PDF-1.7"))).toBe(true);
  });

  it("sanitizes file names (metadata only) and builds safe dispositions", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName('..\\evil"<>.png')).toBe("evil.png");
    expect(sanitizeFileName("")).toBe("file");
    expect(contentDisposition("application/pdf", 'a"b.pdf')).toMatch(/^attachment; filename="a_b.pdf"/);
    expect(contentDisposition("image/png", "é.png")).toMatch(/^inline;.*filename\*=UTF-8''%C3%A9.png/);
  });

  it("generates tenant-prefixed keys without user input", () => {
    expect(objectKeyFor(WS, "image", "abc", new Date("2026-09-25T00:00:00Z"))).toBe(`ws/${WS}/image/2026/09/abc`);
  });
});

describe("artifact lifecycle", () => {
  it("presigns, verifies and serves an upload", async () => {
    const { db, client, store, budget } = setup();
    const { artifact, upload } = await createUpload(client, store, budget, {
      workspaceId: WS, kind: "image", allowedKinds: USER_UPLOAD_KINDS, fileName: "../logo.png",
      contentType: "image/png", sizeBytes: PNG.length, sha256: sha(PNG), actor: user,
    });
    expect(artifact.object_key.startsWith(`ws/${WS}/image/`)).toBe(true);
    expect(artifact.file_name).toBe("logo.png");
    expect(upload.method).toBe("PUT");
    await store.simulateUpload(artifact.object_key, PNG);
    const done = await completeUpload(client, store, { workspaceId: WS, artifactId: artifact.id, actor: user });
    expect(done.status).toBe("available");
    const dl = await signedDownload(client, store, { workspaceId: WS, artifactId: artifact.id, expiresInSeconds: 99999 });
    expect(dl.url).toContain("ttl=3600"); // clamped to 1 hour
    expect(db.tables.product_activity.map((a) => a.action)).toEqual(["artifact.uploaded"]);
  });

  it("quarantines mismatched uploads", async () => {
    const { client, store, budget } = setup();
    const { artifact } = await createUpload(client, store, budget, {
      workspaceId: WS, kind: "image", allowedKinds: USER_UPLOAD_KINDS, fileName: "x.png",
      contentType: "image/png", sizeBytes: 12, sha256: sha(PNG), actor: user,
    });
    const html = new TextEncoder().encode("<html>hello</h");
    await store.simulateUpload(artifact.object_key, html.slice(0, 12));
    const done = await completeUpload(client, store, { workspaceId: WS, artifactId: artifact.id, actor: user });
    expect(done.status).toBe("quarantined");
    await expect(signedDownload(client, store, { workspaceId: WS, artifactId: artifact.id })).rejects.toMatchObject({ code: "not_ready" });
  });

  it("enforces kind, size and workspace quota limits", async () => {
    const { client, store, budget } = setup({ MAX_UPLOAD_SIZE_BYTES: "10", MAX_WORKSPACE_STORAGE_BYTES: "1048576" });
    const base = { workspaceId: WS, allowedKinds: USER_UPLOAD_KINDS, fileName: "x", sha256: sha(PNG), actor: user };
    await expect(createUpload(client, store, budget, { ...base, kind: "trace", contentType: "application/zip", sizeBytes: 5 })).rejects.toMatchObject({ code: "invalid" });
    await expect(createUpload(client, store, budget, { ...base, kind: "image", contentType: "image/svg+xml", sizeBytes: 5 })).rejects.toMatchObject({ code: "invalid" });
    await expect(createUpload(client, store, budget, { ...base, kind: "image", contentType: "image/png", sizeBytes: 11 })).rejects.toMatchObject({ code: "too_large" });
    const big = setup({ MAX_WORKSPACE_STORAGE_BYTES: "1048576" });
    big.db.tables.artifacts.push({ id: "a", workspace_id: WS, size_bytes: 1048570, status: "available" });
    await expect(createUpload(big.client, big.store, big.budget, { ...base, kind: "image", contentType: "image/png", sizeBytes: 100 })).rejects.toMatchObject({ code: "quota" });
  });

  it("never resolves another workspace's artifact", async () => {
    const { client, store, budget } = setup();
    const { artifact } = await createUpload(client, store, budget, {
      workspaceId: WS, kind: "image", allowedKinds: USER_UPLOAD_KINDS, fileName: "x.png",
      contentType: "image/png", sizeBytes: PNG.length, sha256: sha(PNG), actor: user,
    });
    await expect(completeUpload(client, store, { workspaceId: OTHER, artifactId: artifact.id, actor: user })).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteArtifact(client, store, { workspaceId: OTHER, artifactId: artifact.id, actor: user })).rejects.toMatchObject({ code: "not_found" });
  });

  it("gives execution artifacts a retention date and sweeps expired or abandoned objects", async () => {
    const { db, client, store, budget } = setup({ MAX_ARTIFACT_RETENTION_DAYS: "2" });
    const t0 = new Date("2026-09-01T00:00:00Z");
    const { artifact } = await createUpload(client, store, budget, {
      workspaceId: WS, kind: "screenshot", allowedKinds: WORKER_UPLOAD_KINDS, fileName: "s.png",
      contentType: "image/png", sizeBytes: PNG.length, sha256: sha(PNG), actor: { type: "worker", id: "w1" },
    }, t0);
    expect(artifact.retention_until).toBe("2026-09-03T00:00:00.000Z");
    await store.simulateUpload(artifact.object_key, PNG);
    await completeUpload(client, store, { workspaceId: WS, artifactId: artifact.id, actor: { type: "worker", id: "w1" } });
    db.tables.artifacts.push({ id: "stale", workspace_id: WS, object_key: `ws/${WS}/image/x`, status: "pending_upload", created_at: "2026-09-01T00:00:00.000Z" });
    const result = await sweepArtifacts(client, store, new Date("2026-09-04T00:00:00Z"));
    expect(result).toEqual({ deleted: 2, failed: 0 });
    expect(store.objects.size).toBe(0);
    expect(db.tables.artifacts.every((a) => a.status === "deleted")).toBe(true);
  });
});

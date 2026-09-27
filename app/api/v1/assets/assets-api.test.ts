import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySupabase, type MemoryDb } from "@/lib/test/memory-supabase";
import { MemoryObjectStore } from "@/lib/storage/memory";
import { generateWorkerToken, workerLeaseOwner } from "@/lib/workers/tokens";

const WS = "11111111-1111-4111-8111-111111111111";
const TASK = "30000000-0000-4000-8000-000000000001";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const state = vi.hoisted(() => ({
  db: null as unknown as MemoryDb,
  store: null as unknown as MemoryObjectStore,
  role: "member",
  userId: "u1",
  configured: true,
}));

vi.mock("@/lib/product/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/product/api")>("@/lib/product/api");
  return { ...actual, productContext: async () => ({ workspaceId: WS, role: state.role, user: { id: state.userId }, supabase: state.db.client }) };
});
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: async () => state.db.client, createClient: vi.fn() }));
vi.mock("@/lib/storage", async () => {
  const { StorageNotConfiguredError } = await vi.importActual<typeof import("@/lib/storage/object-store")>("@/lib/storage/object-store");
  return {
    getObjectStore: () => {
      if (!state.configured) throw new StorageNotConfiguredError();
      return state.store;
    },
    objectStoreConfigured: () => state.configured,
  };
});

import { GET as list, POST as create } from "./route";
import { GET as detail, DELETE as remove } from "./[assetId]/route";
import { POST as complete } from "./[assetId]/complete/route";
import { POST as workerCreate } from "@/app/api/worker/v1/tasks/[taskId]/artifacts/route";
import { POST as workerComplete } from "@/app/api/worker/v1/tasks/[taskId]/artifacts/[artifactId]/complete/route";

const { token, hash } = generateWorkerToken();
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://app.example/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const p = (assetId: string) => ({ params: Promise.resolve({ assetId }) });

beforeEach(() => {
  state.role = "member";
  state.userId = "u1";
  state.configured = true;
  state.store = new MemoryObjectStore();
  state.db = createMemorySupabase(
    {
      artifacts: [],
      worker_identities: [{ id: "w1", workspace_id: WS, name: "b", modes: ["browser"], max_concurrency: 1, token_hash: hash, revoked_at: null }],
      tasks: [{ id: TASK, workspace_id: WS, state: "running", lease_owner: workerLeaseOwner("w1"), correlation_id: "c", attempts: 1 }],
    },
    { defaults: { artifacts: () => ({ metadata: {}, campaign_id: null, deleted_at: null }) } },
  );
});

describe("assets API", () => {
  it("runs the presign → upload → verify → signed download flow", async () => {
    const res = await create(post({ fileName: "logo.png", contentType: "image/png", sizeBytes: PNG.length, sha256: sha(PNG), kind: "image" }));
    expect(res.status).toBe(201);
    const { artifact, upload } = await res.json();
    expect(upload.url).toMatch(/^memory:\/\/upload/);
    expect((await (await detail(new Request("https://x"), p(artifact.id))).json()).download).toBeNull();
    await state.store.simulateUpload(artifact.object_key, PNG);
    expect((await complete(new Request("https://x"), p(artifact.id))).status).toBe(200);
    const d = await (await detail(new Request("https://x"), p(artifact.id))).json();
    expect(d.download.url).toMatch(/^memory:\/\/download/);
    expect((await (await list(new Request("https://x/api/v1/assets"))).json()).total).toBe(1);
  });

  it("rejects worker-only kinds, bad types and returns 503 when storage is unconfigured", async () => {
    expect((await create(post({ fileName: "t.zip", contentType: "application/zip", sizeBytes: 5, sha256: sha(PNG), kind: "trace" }))).status).toBe(400);
    expect((await create(post({ fileName: "x.svg", contentType: "image/svg+xml", sizeBytes: 5, sha256: sha(PNG), kind: "image" }))).status).toBe(400);
    state.configured = false;
    expect((await create(post({ fileName: "x.png", contentType: "image/png", sizeBytes: 5, sha256: sha(PNG), kind: "image" }))).status).toBe(503);
  });

  it("lets only owners or the uploader delete", async () => {
    const { artifact } = await (await create(post({ fileName: "a.png", contentType: "image/png", sizeBytes: PNG.length, sha256: sha(PNG) }))).json();
    state.userId = "someone-else";
    expect((await remove(new Request("https://x"), p(artifact.id))).status).toBe(403);
    state.role = "owner";
    expect((await remove(new Request("https://x"), p(artifact.id))).status).toBe(200);
    expect((await detail(new Request("https://x"), p("00000000-0000-4000-8000-000000000009"))).status).toBe(404);
  });
});

describe("worker artifact API", () => {
  const auth = { authorization: `Bearer ${token}` };
  const tp = { params: Promise.resolve({ taskId: TASK }) };

  it("uploads execution artifacts bound to the leased task", async () => {
    const res = await workerCreate(post({ kind: "screenshot", fileName: "s.png", contentType: "image/png", sizeBytes: PNG.length, sha256: sha(PNG) }, auth), tp);
    expect(res.status).toBe(201);
    const { artifactId } = await res.json();
    const row = state.db.tables.artifacts[0];
    expect(row).toMatchObject({ task_id: TASK, created_by_worker: "w1" });
    expect(row.retention_until).toBeTruthy();
    await state.store.simulateUpload(String(row.object_key), PNG);
    const done = await workerComplete(post({}, auth), { params: Promise.resolve({ taskId: TASK, artifactId }) });
    expect(await done.json()).toMatchObject({ status: "available" });
  });

  it("refuses without a lease or for user-only kinds", async () => {
    expect((await workerCreate(post({ kind: "image", contentType: "image/png", sizeBytes: 5, sha256: sha(PNG) }, auth), tp)).status).toBe(400);
    state.db.tables.tasks[0].lease_owner = "someone-else";
    const res = await workerCreate(post({ kind: "screenshot", contentType: "image/png", sizeBytes: 5, sha256: sha(PNG) }, auth), tp);
    expect(res.status).toBe(409);
    expect((await workerCreate(post({ kind: "screenshot" }, { authorization: "Bearer nope" }), tp)).status).toBe(401);
  });
});

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySupabase, type MemoryDb } from "@/lib/test/memory-supabase";

const WS = "11111111-1111-4111-8111-111111111111";
const state = vi.hoisted(() => ({ db: null as unknown as MemoryDb, role: "owner" }));

vi.mock("@/lib/product/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/product/api")>("@/lib/product/api");
  return {
    ...actual,
    productContext: async () => ({ workspaceId: WS, role: state.role, user: { id: "owner-1" }, supabase: state.db.client }),
  };
});
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: async () => state.db.client,
  createClient: vi.fn(),
}));

import { GET as list, POST as create } from "./route";
import { GET as detail, POST as act, DELETE as remove } from "./[secretId]/route";
import { POST as importLegacy } from "./import-legacy/route";

const req = (body: unknown) => new Request("https://app.example/api/v1/secrets", { method: "POST", body: JSON.stringify(body) });
const params = (secretId: string) => ({ params: Promise.resolve({ secretId }) });

beforeEach(() => {
  vi.stubEnv("ZERNFLOW_LOCAL_KEK", randomBytes(32).toString("base64"));
  vi.stubEnv("SECRET_STORE_KEK_PROVIDER", "local");
  state.role = "owner";
  state.db = createMemorySupabase(
    { workspaces: [{ id: WS, ai_api_key: "legacy-key-abcdefghijkl" }] },
    { defaults: { secrets: () => ({ status: "active", current_version: 1, expires_at: null, revoked_at: null, binding: null }) } },
  );
});

describe("secrets API", () => {
  it("creates a secret and never returns or logs its value", async () => {
    const res = await create(req({ name: "OpenAI", kind: "ai_provider_key", value: "sk-super-secret-value" }));
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("sk-super-secret-value");
    const listed = await (await list()).text();
    expect(listed).not.toContain("sk-super-secret-value");
    expect(JSON.parse(listed).storeConfigured).toBe(true);
    const id = JSON.parse(text).secret.id;
    const d = await (await detail(new Request("https://x"), params(id))).json();
    expect(d.events.map((e: { action: string }) => e.action)).toEqual(["create"]);
  });

  it("requires owner role for every mutation", async () => {
    state.role = "member";
    expect((await create(req({ name: "x", kind: "other", value: "v" }))).status).toBe(403);
    expect((await act(req({ action: "revoke" }), params("00000000-0000-4000-8000-000000000001"))).status).toBe(403);
    expect((await remove(new Request("https://x"), params("00000000-0000-4000-8000-000000000001"))).status).toBe(403);
    expect((await importLegacy()).status).toBe(403);
  });

  it("validates input and returns 404 for unknown or foreign secrets", async () => {
    expect((await create(req({ name: "x", kind: "nope", value: "v" }))).status).toBe(400);
    expect((await create(req({ name: "x", kind: "other", value: "" }))).status).toBe(400);
    expect((await create(req({ name: "x", kind: "other", value: "v", binding: "Bad Binding" }))).status).toBe(400);
    (state.db.tables.secrets ??= []).push({ id: "00000000-0000-4000-8000-0000000000ff", workspace_id: "other-ws", name: "theirs", status: "active", current_version: 1 });
    expect((await act(req({ action: "rotate", value: "x" }), params("00000000-0000-4000-8000-0000000000ff"))).status).toBe(404);
  });

  it("rotates, revokes and deletes (crypto-shred)", async () => {
    const id = (await (await create(req({ name: "Hook", kind: "webhook_signing", value: "whsec-1" }))).json()).secret.id;
    expect((await act(req({ action: "rotate", value: "whsec-2" }), params(id))).status).toBe(200);
    expect(state.db.tables.secret_versions).toHaveLength(2);
    expect((await act(req({ action: "revoke", reason: "leaked" }), params(id))).status).toBe(200);
    expect((await act(req({ action: "rotate", value: "whsec-3" }), params(id))).status).toBe(409);
    expect((await remove(new Request("https://x"), params(id))).status).toBe(200);
    expect(state.db.tables.secret_versions).toHaveLength(0);
  });

  it("returns 503 when the store is not configured", async () => {
    vi.stubEnv("ZERNFLOW_LOCAL_KEK", "");
    vi.stubEnv("SECRET_STORE_KEK_PROVIDER", "");
    const res = await create(req({ name: "x", kind: "other", value: "v" }));
    expect(res.status).toBe(503);
  });

  it("imports the legacy AI key", async () => {
    const res = await (await importLegacy()).json();
    expect(res.status).toBe("imported");
    expect(state.db.tables.workspaces[0].ai_api_key).toBeNull();
  });
});

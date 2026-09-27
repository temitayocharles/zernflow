import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySupabase, type MemoryDb } from "@/lib/test/memory-supabase";

const WS = "11111111-1111-4111-8111-111111111111";
const state = vi.hoisted(() => ({ db: null as unknown as MemoryDb, role: "owner" }));

vi.mock("@/lib/product/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/product/api")>("@/lib/product/api");
  return { ...actual, productContext: async () => ({ workspaceId: WS, role: state.role, user: { id: "u1" }, supabase: state.db.client }) };
});
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: async () => state.db.client }));

import { POST } from "./route";

const req = (body: unknown) => new Request("https://app.example/api/v1/channels/manual", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  state.role = "owner";
  state.db = createMemorySupabase(
    { channels: [] },
    { constraints: { channels: (r, rows) => (rows.some((x) => x.workspace_id === r.workspace_id && x.late_account_id === r.late_account_id) ? "23505" : null) } },
  );
});

describe("POST /api/v1/channels/manual", () => {
  it("registers a manual channel scoped to the owner's workspace", async () => {
    const res = await POST(req({ platform: "linkedin", handle: "@Brand", displayName: "Brand Inc" }));
    expect(res.status).toBe(201);
    expect(state.db.tables.channels[0]).toMatchObject({ workspace_id: WS, platform: "linkedin", late_account_id: "manual:linkedin:brand", username: "brand", display_name: "Brand Inc", is_active: true });
    expect((await POST(req({ platform: "linkedin", handle: "brand" }))).status).toBe(409);
  });

  it("is owner-only and validates input", async () => {
    expect((await POST(req({ platform: "facebook", handle: "x" }))).status).toBe(400);
    state.role = "member";
    expect((await POST(req({ platform: "linkedin", handle: "x" }))).status).toBe(403);
    expect(state.db.tables.channels).toHaveLength(0);
  });
});

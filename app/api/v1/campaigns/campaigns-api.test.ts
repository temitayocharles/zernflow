import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySupabase, type MemoryDb } from "@/lib/test/memory-supabase";

const WS = "11111111-1111-4111-8111-111111111111";
const C = "c0000000-0000-4000-8000-000000000001";
const D = "d0000000-0000-4000-8000-000000000001";
const V1 = "e0000000-0000-4000-8000-000000000001";
const V2 = "e0000000-0000-4000-8000-000000000002";
const state = vi.hoisted(() => ({ db: null as unknown as MemoryDb, role: "member", rpcCalls: [] as { fn: string; args: unknown }[] }));

vi.mock("@/lib/product/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/product/api")>("@/lib/product/api");
  return { ...actual, productContext: async () => ({ workspaceId: WS, role: state.role, user: { id: "u1" }, supabase: state.db.client }) };
});

import { GET as listCampaigns, POST as createCampaign } from "./route";
import { PATCH as patchCampaign } from "./[campaignId]/route";
import { POST as schedule } from "@/app/api/v1/content/[draftId]/schedule/route";
import { POST as unschedule } from "@/app/api/v1/content/[draftId]/unschedule/route";
import { POST as confirm } from "@/app/api/v1/content/variants/[variantId]/confirm/route";
import { POST as reconcile } from "@/app/api/v1/content/variants/[variantId]/reconcile/route";
import { GET as capabilities } from "@/app/api/v1/publishing/capabilities/route";

const req = (body: unknown, method = "POST") =>
  new Request("https://app.example/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  state.role = "member";
  state.rpcCalls = [];
  const record = (fn: string) => (args: Record<string, unknown>) => {
    state.rpcCalls.push({ fn, args });
    if (fn === "schedule_content_item" && (args.p_plan as unknown[]).length === 0) throw Object.assign(new Error("nothing to schedule"), { code: "22023" });
    if (fn === "confirm_manual_publication" && !String(args.p_external_url).startsWith("https://")) throw Object.assign(new Error("external url must be https"), { code: "23514" });
    if (fn === "resolve_publication") return args.p_outcome;
    return fn === "confirm_manual_publication" ? "published" : (args.p_plan as unknown[] | undefined)?.length ?? 1;
  };
  state.db = createMemorySupabase(
    {
      campaigns: [{ id: C, workspace_id: WS, name: "Fall", status: "active", version: 3, utm_defaults: {}, requires_approval: false, channel_ids: [], created_at: "1" }],
      editorial_drafts: [{ id: D, workspace_id: WS, name: "Teaser", body: "Base", kind: "post", state: "approved", link_url: null, utm: {}, asset_ids: [], campaign_id: C }],
      editorial_variants: [
        { id: V1, workspace_id: WS, draft_id: D, channel_id: "ch-ig", body: "IG", publish_state: "draft", created_at: "1" },
        { id: V2, workspace_id: WS, draft_id: D, channel_id: "ch-fb", body: "FB", publish_state: "draft", created_at: "2" },
      ],
      channels: [
        { id: "ch-ig", workspace_id: WS, platform: "instagram", username: "b" },
        { id: "ch-fb", workspace_id: WS, platform: "facebook", username: "b" },
      ],
    },
    {
      rpc: {
        schedule_content_item: record("schedule_content_item"),
        unschedule_content_item: record("unschedule_content_item"),
        confirm_manual_publication: record("confirm_manual_publication"),
        resolve_publication: record("resolve_publication"),
      },
    },
  );
});

describe("campaign API", () => {
  it("creates, lists, and enforces status flow, owner-only archive and optimistic versions", async () => {
    const created = await createCampaign(req({ name: "Launch", objective: "launch" }));
    expect(created.status).toBe(201);
    expect((await created.json()).campaign).toMatchObject({ workspace_id: WS, owner_id: "u1", created_by: "u1" });
    expect(await createCampaign(req({ name: "x", results: { leads: 99 } })).then((r) => r.status)).toBe(400);
    const list = await (await listCampaigns(new Request("https://app.example/x?status=active"))).json();
    expect(list.campaigns.map((c: { id: string }) => c.id)).toEqual([C]);
    const p = { params: Promise.resolve({ campaignId: C }) };
    expect((await patchCampaign(req({ status: "draft", version: 3 }, "PATCH"), p)).status).toBe(409);
    expect((await patchCampaign(req({ status: "archived", version: 3 }, "PATCH"), p)).status).toBe(403);
    expect((await patchCampaign(req({ status: "paused", version: 2 }, "PATCH"), p)).status).toBe(409);
    const ok = await patchCampaign(req({ status: "paused", version: 3 }, "PATCH"), p);
    expect(ok.status).toBe(200);
    expect(state.db.tables.campaigns[0].status).toBe("paused");
    expect((await patchCampaign(req({ status: "paused", version: 3 }, "PATCH"), { params: Promise.resolve({ campaignId: "nope" }) })).status).toBe(400);
  });
});

describe("content scheduling API", () => {
  const p = { params: Promise.resolve({ draftId: D }) };
  it("reports blocked variants instead of dropping them, and schedules valid ones only when partial is allowed", async () => {
    const blocked = await schedule(req({}), p);
    expect(blocked.status).toBe(422);
    const body = await blocked.json();
    expect(body.blocked).toEqual([expect.objectContaining({ variantId: V1 })]);
    expect(state.rpcCalls).toHaveLength(0);
    const ok = await schedule(req({ allowPartial: true, at: "2026-10-01T12:00:00Z" }), p);
    expect(ok.status).toBe(200);
    expect(state.rpcCalls[0]).toEqual({ fn: "schedule_content_item", args: { p_draft: D, p_at: "2026-10-01T12:00:00.000Z", p_plan: [{ variantId: V2, mode: "manual" }] } });
  });

  it("rejects unavailable modes, unknown variants, and foreign drafts", async () => {
    expect((await schedule(req({ variantIds: [V2], modes: { [V2]: "api" } }), p)).status).toBe(422);
    expect((await schedule(req({ variantIds: ["e0000000-0000-4000-8000-000000000009"] }), p)).status).toBe(400);
    expect((await schedule(req({}), { params: Promise.resolve({ draftId: "d0000000-0000-4000-8000-000000000009" }) })).status).toBe(404);
    expect((await schedule(req({ modes: { [V2]: "teleport" } }), p)).status).toBe(400);
    const dry = await (await schedule(req({ dryRun: true }), p)).json();
    expect(dry.plan).toEqual([{ variantId: V2, mode: "manual" }]);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("unschedules and confirms manual publications through the RPCs", async () => {
    expect((await unschedule(req(undefined), p)).status).toBe(200);
    expect(state.rpcCalls.at(-1)).toEqual({ fn: "unschedule_content_item", args: { p_draft: D, p_variant: null } });
    await unschedule(req({ variantId: V1 }), p);
    expect(state.rpcCalls.at(-1)?.args).toEqual({ p_draft: D, p_variant: V1 });
    const v = { params: Promise.resolve({ variantId: V2 }) };
    expect(await (await confirm(req({ externalUrl: "https://facebook.com/p/1" }), v)).json()).toEqual({ state: "published" });
    const bad = await confirm(req({ externalUrl: "http://insecure" }), v);
    expect(bad.status).toBe(409);
    expect((await bad.json()).error).toContain("https");
  });

  it("reconciles ambiguous publications through resolve_publication", async () => {
    const v = { params: Promise.resolve({ variantId: V1 }) };
    expect((await reconcile(req({ outcome: "maybe" }), v)).status).toBe(400);
    expect((await reconcile(req({ outcome: "published" }), v)).status).toBe(400); // link required
    expect(await (await reconcile(req({ outcome: "published", externalUrl: "https://x.com/s/1", externalRef: "1" }), v)).json()).toEqual({ state: "published" });
    expect(state.rpcCalls.at(-1)).toEqual({ fn: "resolve_publication", args: { p_variant: V1, p_outcome: "published", p_external_url: "https://x.com/s/1", p_external_ref: "1" } });
    await reconcile(req({ outcome: "not_published", externalUrl: "https://ignored" }), v);
    expect(state.rpcCalls.at(-1)?.args).toEqual({ p_variant: V1, p_outcome: "not_published", p_external_url: null, p_external_ref: null });
    expect((await reconcile(req({ outcome: "published", externalUrl: "https://x" }), { params: Promise.resolve({ variantId: "nope" }) })).status).toBe(400);
  });

  it("publishes capabilities without claiming unregistered adapters", async () => {
    const data = await (await capabilities()).json();
    const ig = data.platforms.find((x: { platform: string }) => x.platform === "instagram");
    expect(ig.modes.post.find((m: { mode: string }) => m.mode === "api").available).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySupabase, type MemoryDb } from "@/lib/test/memory-supabase";
import { FixedWindowLimiter } from "@/lib/security/rate-limit";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const state = vi.hoisted(() => ({ db: null as unknown as MemoryDb }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: async () => state.db.client, createClient: vi.fn() }));

import { authenticateIntake, generateIntakeToken, intakeLead, parseLead } from "./intake";
import { campaignForPost, recordCommentTouchpoint, resolveCampaignFromUtm } from "./service";
import { POST as intake } from "@/app/api/intake/v1/leads/route";

let token: string;
beforeEach(() => {
  const t = generateIntakeToken();
  token = t.token;
  state.db = createMemorySupabase(
    {
      contacts: [{ id: "c-existing", workspace_id: WS, email: "Ada@Example.com", display_name: "Ada" }],
      campaigns: [
        { id: "camp-slug", workspace_id: WS, name: "Spring Launch 2026", utm_defaults: {}, status: "active", created_at: "2026-01-01" },
        { id: "camp-explicit", workspace_id: WS, name: "Other", utm_defaults: { campaign: "spring-launch-2026" }, status: "active", created_at: "2026-02-01" },
        { id: "camp-foreign", workspace_id: OTHER, name: "Summer", utm_defaults: {}, status: "active", created_at: "2026-03-01" },
      ],
      lead_intake_tokens: [
        { id: "tok-1", workspace_id: WS, name: "Site", token_hash: t.hash, default_campaign_id: null, revoked_at: null },
      ],
      editorial_variants: [{ id: "var-1", workspace_id: WS, channel_id: "ch-1", draft_id: "d-1", external_ref: "post-1" }],
      editorial_drafts: [{ id: "d-1", workspace_id: WS, campaign_id: "camp-slug" }],
      contact_touchpoints: [],
      product_activity: [],
    },
    { constraints: { contact_touchpoints: (r, rows) => (r.dedupe_key && rows.some((x) => x.dedupe_key === r.dedupe_key && x.workspace_id === r.workspace_id) ? "23505" : null) } },
  );
});

describe("lead parsing", () => {
  it("normalises email and merges UTM from the landing URL with explicit values", () => {
    const lead = parseLead({ email: " Ada@Example.COM ".trim(), landingUrl: "https://site.example/p?utm_source=newsletter&utm_campaign=spring&x=1", utm: { campaign: "spring-launch-2026" } }, "abc-1");
    expect(lead).toMatchObject({ email: "ada@example.com", utm: { utm_source: "newsletter", utm_campaign: "spring-launch-2026" }, idempotencyKey: "abc-1" });
  });
  it("rejects bad emails, non-web landing URLs and unsafe idempotency keys", () => {
    expect(() => parseLead({ email: "nope" }, null)).toThrow(/email/);
    expect(() => parseLead({ email: "a@b.co", landingUrl: "javascript:alert(1)" }, null)).toThrow(/landingUrl/);
    expect(() => parseLead({ email: "a@b.co" }, "bad key with spaces")).toThrow(/Idempotency-Key/);
  });
});

describe("attribution resolution", () => {
  it("prefers an explicit campaign UTM default over the name slug, and never crosses workspaces", async () => {
    expect(await resolveCampaignFromUtm(state.db.client as never, WS, { utm_campaign: "spring-launch-2026" })).toBe("camp-explicit");
    expect(await resolveCampaignFromUtm(state.db.client as never, WS, { utm_campaign: "summer" })).toBeNull();
    expect(await resolveCampaignFromUtm(state.db.client as never, WS, {})).toBeNull();
  });

  it("maps a comment on a published post to its campaign, once per comment", async () => {
    expect(await campaignForPost(state.db.client as never, { workspaceId: WS, channelId: "ch-1", postId: "post-1" })).toEqual({ variantId: "var-1", campaignId: "camp-slug" });
    expect(await campaignForPost(state.db.client as never, { workspaceId: OTHER, channelId: "ch-1", postId: "post-1" })).toBeNull();
    const input = { workspaceId: WS, channelId: "ch-1", contactId: "c-existing", postId: "post-1", commentId: "cm-1", platform: "instagram" };
    await recordCommentTouchpoint(state.db.client as never, input);
    await recordCommentTouchpoint(state.db.client as never, input);
    expect(state.db.tables.contact_touchpoints).toHaveLength(1);
    expect(state.db.tables.contact_touchpoints[0]).toMatchObject({ source: "comment", campaign_id: "camp-slug", variant_id: "var-1", external_ref: "post-1" });
  });
});

describe("lead intake", () => {
  it("authenticates by token hash and refuses revoked or malformed tokens", async () => {
    expect(await authenticateIntake(state.db.client as never, `Bearer ${token}`)).toMatchObject({ id: "tok-1", workspace_id: WS });
    expect(await authenticateIntake(state.db.client as never, `Bearer ${generateIntakeToken().token}`)).toBeNull();
    expect(await authenticateIntake(state.db.client as never, "Bearer zfl_short")).toBeNull();
    state.db.tables.lead_intake_tokens[0].revoked_at = "2026-01-01";
    expect(await authenticateIntake(state.db.client as never, `Bearer ${token}`)).toBeNull();
  });

  it("matches existing contacts case-insensitively (LIKE wildcards escaped) and creates new ones once", async () => {
    const tok = { id: "tok-1", workspace_id: WS, default_campaign_id: null };
    const again = await intakeLead(state.db.client as never, tok, parseLead({ email: "ada@example.com" }, null));
    expect(again).toMatchObject({ contactId: "c-existing", created: false });
    const wildcard = await intakeLead(state.db.client as never, tok, parseLead({ email: "_da@example.com" }, null));
    expect(wildcard.created).toBe(true);
    expect(state.db.tables.product_activity.map((a) => a.action)).toContain("contact.created_via_intake");
  });

  it("route: 401 without a token, 201 then idempotent 200 with attribution, 400 on bad input", async () => {
    const req = (body: unknown, headers: Record<string, string> = {}) =>
      new Request("https://app.example/api/intake/v1/leads", { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    expect((await intake(new Request("https://app.example/api/intake/v1/leads", { method: "POST", body: "{}" }))).status).toBe(401);
    const first = await intake(req({ email: "new@lead.example", name: "New", utm: { utm_campaign: "spring-launch-2026", utm_source: "google" } }, { "idempotency-key": "form-42" }));
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ ok: true, created: true, attributed: true, duplicate: false });
    const replay = await intake(req({ email: "new@lead.example", utm: { utm_campaign: "spring-launch-2026" } }, { "idempotency-key": "form-42" }));
    expect(await replay.json()).toMatchObject({ created: false, duplicate: true });
    expect(state.db.tables.contact_touchpoints).toHaveLength(1);
    expect(state.db.tables.contact_touchpoints[0]).toMatchObject({ source: "form", campaign_id: "camp-explicit", dedupe_key: "intake:tok-1:form-42" });
    expect((await intake(req("{not json"))).status).toBe(400);
    expect((await intake(req({ email: "x" }))).status).toBe(400);
    expect((await intake(req("x".repeat(9000)))).status).toBe(413);
  });
});

describe("rate limiter", () => {
  it("allows the limit per window, reports the wait, then resets", () => {
    const l = new FixedWindowLimiter(2, 1000);
    expect([l.take("k", 0), l.take("k", 10), l.take("k", 20)]).toEqual([0, 0, 980]);
    expect(l.take("other", 20)).toBe(0);
    expect(l.take("k", 1000)).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { availableModes, registerApiPublishAdapter, resolveMode, profileFor } from "./capabilities";
import { buildTrackedLink, normalizeUtm, slugify } from "./utm";
import { composeText, summarizePublishState, textLength, validateVariant } from "./compose";
import { contentPublishHandler, loadPublishContext, planSchedule, settleRemotePublish } from "./service";
import { reconcilePublishing, remindManualPublications } from "./sweeps";
import { parseCampaignInput, statusTransitionAllowed } from "./campaign-input";
import { createMemorySupabase } from "@/lib/test/memory-supabase";
import { readBudget } from "@/lib/runtime/budget";
import { TaskError } from "@/lib/tasks/errors";
import { registerPublishingProvider, unregisterPublishingProvider } from "./contract";
import { receiptsByVariant, type ReceiptView } from "./display";

const WS = "11111111-1111-4111-8111-111111111111";
const D = "d0000000-0000-4000-8000-000000000001";
const V_IG = "e0000000-0000-4000-8000-000000000001";
const V_FB = "e0000000-0000-4000-8000-000000000002";

describe("capabilities", () => {
  it("never claims API or browser publishing without a registered adapter", () => {
    const modes = availableModes("instagram", "post");
    expect(modes.find((m) => m.mode === "api")?.available).toBe(false);
    expect(modes.find((m) => m.mode === "browser")?.available).toBe(false);
    expect(modes.find((m) => m.mode === "manual")?.available).toBe(true);
    expect(resolveMode("instagram", "post")).toEqual({ mode: "manual" });
    expect(resolveMode("instagram", "post", "api")).toHaveProperty("error");
  });
});

describe("utm and composition", () => {
  it("builds tracked links without overriding explicit parameters", () => {
    const url = buildTrackedLink("https://shop.example/p?utm_source=newsletter", {
      campaignName: "Fall Launch 2026!", campaignUtm: { medium: "organic" }, contentUtm: { utm_term: "boots" }, platform: "facebook", variantId: "abcdef123456",
    });
    const u = new URL(url!);
    expect(u.searchParams.get("utm_source")).toBe("newsletter");
    expect(u.searchParams.get("utm_medium")).toBe("organic");
    expect(u.searchParams.get("utm_campaign")).toBe("fall-launch-2026");
    expect(u.searchParams.get("utm_term")).toBe("boots");
    expect(u.searchParams.get("utm_content")).toBe("abcdef12");
    expect(buildTrackedLink("javascript:alert(1)", { platform: "x" })).toBeNull();
    expect(normalizeUtm({ source: "a", bogus: "b", medium: 3 })).toEqual({ utm_source: "a" });
    expect(slugify("Émile & Co")).toBe("emile-co");
  });

  it("appends links only where the platform renders them and validates limits", () => {
    expect(composeText("Hi", "https://x.test", profileFor("facebook"))).toBe("Hi\n\nhttps://x.test");
    expect(composeText("Hi", "https://x.test", profileFor("instagram"))).toBe("Hi");
    expect(textLength("👍🏽ab")).toBe(3);
    expect(validateVariant(profileFor("instagram"), { text: "hello", kind: "post", media: [] })).toEqual([expect.stringMatching(/requires image or video/)]);
    expect(validateVariant(profileFor("twitter"), { text: "x".repeat(281), kind: "post", media: [] })[0]).toMatch(/280/);
    expect(validateVariant(profileFor("tiktok"), { text: "x", kind: "post", media: [{ contentType: "image/png" }] }).length).toBe(2);
    expect(validateVariant(null, { text: "x", kind: "post", media: [] })).toHaveLength(1);
  });

  it("aggregates content state", () => {
    expect(summarizePublishState([])).toBe("draft");
    expect(summarizePublishState(["published", "published"])).toBe("published");
    expect(summarizePublishState(["published", "failed"])).toBe("partially_published");
    expect(summarizePublishState(["scheduled", "published"])).toBe("scheduled");
    expect(summarizePublishState(["queued", "scheduled"])).toBe("queued");
    expect(summarizePublishState(["publishing", "failed"])).toBe("publishing");
    expect(summarizePublishState(["failed", "failed"])).toBe("failed");
    expect(summarizePublishState(["cancelled"])).toBe("cancelled");
  });
});

describe("campaign input", () => {
  it("validates fields and status transitions", () => {
    expect(parseCampaignInput({ name: "Launch", objective: "launch", utm_defaults: { utm_source: "ig", junk: "x" } })).toEqual({
      name: "Launch", objective: "launch", utm_defaults: { source: "ig" },
    });
    expect(() => parseCampaignInput({ name: "x", results: {} })).toThrow(/Unknown field/);
    expect(() => parseCampaignInput({ name: "x", timezone: "Mars/Base" })).toThrow(/timezone/);
    expect(() => parseCampaignInput({ status: "active" }, true)).toThrow(/version/);
    expect(() => parseCampaignInput({ name: "x", starts_at: "2026-10-02T00:00:00Z", ends_at: "2026-10-01T00:00:00Z" })).toThrow(/after/);
    expect(statusTransitionAllowed("draft", "active")).toBe(true);
    expect(statusTransitionAllowed("archived", "active")).toBe(false);
  });
});

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return createMemorySupabase({
    editorial_drafts: [{ id: D, workspace_id: WS, name: "Teaser", body: "Base", kind: "post", link_url: "https://shop.example", utm: {}, asset_ids: [], campaign_id: "c1", created_at: "1" }],
    campaigns: [{ id: "c1", workspace_id: WS, name: "Fall", utm_defaults: {}, requires_approval: true, status: "active" }],
    editorial_variants: [
      { id: V_IG, workspace_id: WS, draft_id: D, channel_id: "ch-ig", body: "IG text", publish_state: "draft", attempt_count: 0, created_at: "1" },
      { id: V_FB, workspace_id: WS, draft_id: D, channel_id: "ch-fb", body: "FB text", publish_state: "draft", attempt_count: 0, created_at: "2" },
    ],
    channels: [
      { id: "ch-ig", workspace_id: WS, platform: "instagram", username: "brand", late_account_id: "ig1" },
      { id: "ch-fb", workspace_id: WS, platform: "facebook", username: "brand", late_account_id: "fb1" },
    ],
    artifacts: [],
    ...extra,
  });
}

describe("planning", () => {
  it("blocks variants that violate platform rules and plans the rest", async () => {
    const db = seed();
    const ctx = (await loadPublishContext(db.client as never, WS, D))!;
    expect(ctx.variants.map((v) => v.platform)).toEqual(["instagram", "facebook"]);
    const plan = planSchedule(ctx);
    expect(plan.plan).toEqual([{ variantId: V_FB, mode: "manual" }]);
    expect(plan.blocked[0]).toMatchObject({ variantId: V_IG, issues: [expect.stringMatching(/requires/)] });
    expect(() => planSchedule(ctx, { variantIds: ["e0000000-0000-4000-8000-000000000099"] })).toThrow(/Unknown variant/);
    expect(await loadPublishContext(db.client as never, "other-ws", D)).toBeNull();
  });
});

function taskCtx(db: ReturnType<typeof seed>, overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  return {
    ctx: {
      task: { id: "t1", workspace_id: WS, idempotency_key: "publish:k", attempts: 1, retry_policy: { maxAttempts: 3 }, ...overrides } as never,
      supabase: db.client as never,
      budget: readBudget({}),
      deadline: Date.now() + 20_000,
      event: async (_l: string, m: string) => void events.push(m),
      execute: async <T,>(_i: unknown, fn: () => Promise<T>) => fn(),
    },
    events,
  };
}

describe("content.publish handler", () => {
  it("skips stale tasks and refuses API mode without an adapter (variant marked failed)", async () => {
    const db = seed();
    db.tables.editorial_variants[1] = { ...db.tables.editorial_variants[1], publish_state: "scheduled", idempotency_key: "publish:k", execution_mode: "api" };
    const input = contentPublishHandler.parseInput({ variantId: V_FB, draftId: D, channelId: "ch-fb", mode: "api" });
    const stale = taskCtx(db, { idempotency_key: "publish:other" });
    expect(await contentPublishHandler.run!(stale.ctx as never, input)).toMatchObject({ status: "completed", result: { skipped: "variant_scheduled" } });
    const { ctx } = taskCtx(db);
    await expect(contentPublishHandler.run!(ctx as never, input)).rejects.toMatchObject({ errorClass: "unsupported_capability" });
    expect(db.tables.editorial_variants[1].publish_state).toBe("failed");
  });

  it("publishes through a registered adapter with the tracked link and records the external post", async () => {
    const seen: string[] = [];
    registerApiPublishAdapter({
      id: "test-adapter", platforms: ["telegram"], kinds: ["post"],
      publish: async (p) => { seen.push(p.text); return { externalRef: "msg-1", externalUrl: "https://t.me/brand/1" }; },
    });
    const db = seed();
    db.tables.channels.push({ id: "ch-tg", workspace_id: WS, platform: "telegram", late_account_id: "tg1" });
    db.tables.editorial_variants.push({ id: "v-tg", workspace_id: WS, draft_id: D, channel_id: "ch-tg", body: "TG", publish_state: "scheduled", idempotency_key: "publish:k", attempt_count: 0, created_at: "3" });
    const { ctx } = taskCtx(db);
    const out = await contentPublishHandler.run!(ctx as never, { variantId: "v-tg", draftId: D, channelId: "ch-tg", mode: "api" });
    expect(out).toMatchObject({ status: "completed", result: { externalRef: "msg-1" } });
    expect(seen[0]).toMatch(/^TG\n\nhttps:\/\/shop\.example\/\?utm_source=telegram&utm_medium=social&utm_campaign=fall/);
    expect(db.tables.editorial_variants.find((v) => v.id === "v-tg")).toMatchObject({ publish_state: "published", external_url: "https://t.me/brand/1", attempt_count: 1 });
  });

  it("resumes a publishing variant by polling its accepted operation (provider-neutral engine)", async () => {
    registerPublishingProvider({
      id: "async-test", platforms: ["bluesky"], idempotentSubmit: false,
      capability: (p) => (p === "bluesky" ? { level: "available", reason: "test" } : { level: "unavailable", reason: "no" }),
      submit: async () => ({ status: "accepted", operationRef: "op-7" }),
      status: async () => ({ status: "published", externalRef: "at://post", externalUrl: "https://bsky.app/p/1" }),
    });
    const db = seed();
    db.tables.channels.push({ id: "ch-bs", workspace_id: WS, platform: "bluesky", late_account_id: "b1" });
    db.tables.editorial_variants.push({ id: "v-bs", workspace_id: WS, draft_id: D, channel_id: "ch-bs", body: "B", publish_state: "scheduled", idempotency_key: "publish:k", attempt_count: 0, created_at: "5" });
    db.tables.publish_receipts ??= [];
    const input = { variantId: "v-bs", draftId: D, channelId: "ch-bs", mode: "api" as const };
    const first = await contentPublishHandler.run!(taskCtx(db).ctx as never, input);
    expect(first).toMatchObject({ status: "deferred", step: expect.stringMatching(/^publish-op:/) });
    expect(db.tables.editorial_variants.find((v) => v.id === "v-bs")?.publish_state).toBe("publishing");
    db.tables.publish_receipts[0].poll_count ??= 0;
    const second = await contentPublishHandler.run!(taskCtx(db).ctx as never, input);
    expect(second).toMatchObject({ status: "completed", result: { externalRef: "at://post" } });
    expect(db.tables.editorial_variants.find((v) => v.id === "v-bs")).toMatchObject({ publish_state: "published", attempt_count: 1 });
    unregisterPublishingProvider("async-test");
  });

  it("marks the variant queued on retryable adapter errors", async () => {
    registerApiPublishAdapter({ id: "flaky", platforms: ["reddit"], kinds: ["post"], publish: async () => { throw new TaskError("rate_limited", "slow down"); } });
    const db = seed();
    db.tables.channels.push({ id: "ch-rd", workspace_id: WS, platform: "reddit", late_account_id: "r1" });
    db.tables.editorial_variants.push({ id: "v-rd", workspace_id: WS, draft_id: D, channel_id: "ch-rd", body: "R", publish_state: "scheduled", idempotency_key: "publish:k", attempt_count: 0, created_at: "4" });
    const { ctx } = taskCtx(db);
    await expect(contentPublishHandler.run!(ctx as never, { variantId: "v-rd", draftId: D, channelId: "ch-rd", mode: "api" })).rejects.toThrow(/slow down/);
    expect(db.tables.editorial_variants.find((v) => v.id === "v-rd")).toMatchObject({ publish_state: "queued", last_error: "slow down" });
  });
});

describe("remote settlement and reconciliation", () => {
  it("settles browser-worker outcomes only for the matching task", async () => {
    const db = seed();
    db.tables.editorial_variants[0] = { ...db.tables.editorial_variants[0], publish_state: "scheduled", idempotency_key: "k1" };
    const task = { id: "t", kind: "content.publish", workspace_id: WS, input: { variantId: V_IG }, idempotency_key: "k1" };
    await settleRemotePublish(db.client as never, { ...task, idempotency_key: "other" }, { status: "completed", result: {} });
    expect(db.tables.editorial_variants[0].publish_state).toBe("scheduled");
    db.tables.publish_receipts ??= [];
    await settleRemotePublish(db.client as never, { ...task, attempts: 2 }, { status: "completed", result: { externalUrl: "javascript:x", externalRef: "p1" } });
    expect(db.tables.editorial_variants[0]).toMatchObject({ publish_state: "published", external_url: null, external_ref: "p1" });
    expect(db.tables.publish_receipts).toEqual([
      expect.objectContaining({ mode: "browser", provider: "browser:instagram", status: "published", attempt: 2, external_ref: "p1", external_url: null, idempotency_key: "k1" }),
    ]);
    db.tables.editorial_variants[1] = { ...db.tables.editorial_variants[1], publish_state: "publishing", idempotency_key: "k2" };
    await settleRemotePublish(db.client as never, { ...task, input: { variantId: V_FB }, idempotency_key: "k2", attempts: 1 }, { status: "waiting_for_user", message: "may have posted", errorClass: "unknown_outcome" });
    expect(db.tables.publish_receipts[1]).toMatchObject({ provider: "browser:facebook", status: "unknown", error_class: "unknown_outcome" });
    expect(db.tables.editorial_variants[1].publish_state).toBe("failed");
  });

  it("groups receipts per variant and flags only ambiguous stopped attempts for reconciliation", () => {
    const r = (id: string, variant_id: string, attempt: number, status: ReceiptView["status"], key = "k"): ReceiptView =>
      ({ id, variant_id, idempotency_key: key, attempt, status, mode: "api", provider: "p", external_url: null, error_class: null, error_message: null, created_at: `2026-09-2${attempt}` });
    const out = receiptsByVariant(
      [r("1", "a", 1, "failed"), r("2", "a", 2, "unknown"), r("3", "b", 1, "partial", "old"), r("4", "c", 1, "unknown")],
      [
        { id: "a", idempotency_key: "k", publish_state: "failed", execution_mode: "api" },
        { id: "b", idempotency_key: "new", publish_state: "failed", execution_mode: "api" },
        { id: "c", idempotency_key: "k", publish_state: "failed", execution_mode: "manual" },
      ],
    );
    expect(out.a).toMatchObject({ needsReconcile: true, latest: { id: "2" } });
    expect(out.a.all.map((x) => x.id)).toEqual(["2", "1"]);
    expect(out.b).toMatchObject({ needsReconcile: false, latest: null }); // receipt is from an older schedule
    expect(out.c.needsReconcile).toBe(false);
  });

  it("aligns variant state with task state", async () => {
    const db = seed({
      tasks: [
        { id: "t-run", state: "running" }, { id: "t-fail", state: "failed", error: { message: "boom" } },
        { id: "t-cancel", state: "cancelled" }, { id: "t-done", state: "completed", result: { externalUrl: "https://x.test/p" } },
        { id: "t-poll", state: "waiting", current_step: "publish-op:r1" }, { id: "t-wait", state: "waiting", current_step: null },
      ],
    });
    db.tables.editorial_variants = [
      { id: "a", workspace_id: WS, publish_state: "scheduled", task_id: "t-run" },
      { id: "b", workspace_id: WS, publish_state: "queued", task_id: "t-fail" },
      { id: "c", workspace_id: WS, publish_state: "scheduled", task_id: "t-cancel" },
      { id: "d", workspace_id: WS, publish_state: "publishing", task_id: "t-done" },
      { id: "e", workspace_id: WS, publish_state: "scheduled", task_id: null },
      { id: "f", workspace_id: WS, publish_state: "publishing", task_id: "t-poll" },
      { id: "g", workspace_id: WS, publish_state: "publishing", task_id: "t-wait" },
    ];
    await reconcilePublishing(db.client as never);
    expect(Object.fromEntries(db.tables.editorial_variants.map((v) => [v.id, v.publish_state]))).toEqual({
      a: "publishing", b: "failed", c: "cancelled", d: "published", e: "failed", f: "publishing", g: "queued",
    });
    expect(db.tables.editorial_variants.find((v) => v.id === "b")?.last_error).toBe("boom");
  });

  it("flags due manual publications once and notifies owners", async () => {
    const db = createMemorySupabase(
      {
        tasks: [
          { id: "m1", workspace_id: WS, kind: "content.publish", execution_mode: "human", state: "queued", human_intervention: "none", next_run_at: "2026-09-01T00:00:00Z", objective: "Publish X", input: { draftId: D } },
          { id: "m2", workspace_id: WS, kind: "content.publish", execution_mode: "human", state: "queued", human_intervention: "none", next_run_at: "2027-01-01T00:00:00Z", objective: "Later", input: {} },
        ],
        workspace_members: [{ workspace_id: WS, user_id: "owner", role: "owner" }],
        operator_notifications: [],
      },
      { constraints: { operator_notifications: (r, rows) => (rows.some((x) => x.dedupe_key === r.dedupe_key && x.recipient_id === r.recipient_id) ? "23505" : null) } },
    );
    expect(await remindManualPublications(db.client as never, new Date("2026-09-25T00:00:00Z"))).toEqual({ due: 1, notified: 1 });
    expect(await remindManualPublications(db.client as never, new Date("2026-09-25T00:00:00Z"))).toEqual({ due: 0, notified: 0 });
    expect(db.tables.tasks[0].human_intervention).toBe("requested");
    expect(db.tables.operator_notifications[0]).toMatchObject({ entity_type: "editorial_drafts", entity_id: D });
  });
});

import { dayKey, monthGrid, monthWindow, parseMonth, shiftMonth, validTimeZone } from "./calendar";
describe("calendar helpers", () => {
  it("groups by local day and builds Monday-first grids", () => {
    expect(dayKey("2026-10-01T02:00:00Z", "America/Toronto")).toBe("2026-09-30");
    expect(dayKey("2026-10-01T02:00:00Z", "UTC")).toBe("2026-10-01");
    const g = monthGrid(2026, 10);
    expect(g[0][0]).toEqual({ key: "2026-09-28", day: 28, inMonth: false });
    expect(g.flat().filter((d) => d.inMonth)).toHaveLength(31);
    expect(shiftMonth(2026, 1, -1)).toBe("2025-12");
    expect(parseMonth("2026-13", new Date("2026-09-25T00:00:00Z"))).toEqual({ year: 2026, month: 9 });
    expect(validTimeZone("Nope/Zone")).toBeNull();
    expect(monthWindow(2026, 10).from).toBe("2026-09-30T10:00:00.000Z");
  });
});

import { describe, expect, it } from "vitest";
import { createMemorySupabase } from "@/lib/test/memory-supabase";
import { readBudget } from "@/lib/runtime/budget";
import { contentRecurHandler, occurrenceName } from "./recurring";
import { repeatCron } from "./repeat-cron";
import { parseScheduleInput } from "@/lib/tasks/schedule-input";

const WS = "11111111-1111-4111-8111-111111111111";
const SRC = "d0000000-0000-4000-8000-000000000001";

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return createMemorySupabase(
    {
      editorial_drafts: [{ id: SRC, workspace_id: WS, name: "Tip of the week", body: "Body", kind: "post", link_url: "https://shop.example", utm: { utm_campaign: "tips" }, asset_ids: ["a1", "a-gone"], campaign_id: "camp", timezone: "America/Toronto", state: "approved", source_task_id: null }],
      editorial_variants: [
        { id: "v1", workspace_id: WS, draft_id: SRC, channel_id: "ch-li", body: "LI", media_refs: [], publish_state: "published" },
        { id: "v2", workspace_id: WS, draft_id: SRC, channel_id: "ch-off", body: "OFF", media_refs: [], publish_state: "published" },
      ],
      channels: [{ id: "ch-li", workspace_id: WS, is_active: true }, { id: "ch-off", workspace_id: WS, is_active: false }],
      campaigns: [{ id: "camp", workspace_id: WS, status: "active" }],
      artifacts: [{ id: "a1", workspace_id: WS, status: "available" }],
      workspace_members: [{ workspace_id: WS, user_id: "owner", role: "owner" }, { workspace_id: WS, user_id: "m", role: "member" }],
      operator_notifications: [],
      task_events: [],
      ...extra,
    },
    { constraints: { editorial_drafts: (r, rows) => (r.source_task_id && rows.some((x) => x.source_task_id === r.source_task_id) ? "23505" : null) } },
  );
}

const ctx = (db: ReturnType<typeof seed>, taskId = "task-1") =>
  ({ task: { id: taskId, workspace_id: WS }, supabase: db.client, budget: readBudget({}), deadline: Date.now() + 20_000, event: async () => undefined, execute: async <T,>(_: unknown, fn: () => Promise<T>) => fn() }) as never;

describe("content.recur", () => {
  it("materialises one draft copy per occurrence with active variants and live assets, and notifies owners", async () => {
    const db = seed();
    const out = await contentRecurHandler.run!(ctx(db), { draftId: SRC });
    expect(out).toMatchObject({ status: "completed", result: { variants: 1, droppedAssets: 1 } });
    const copy = db.tables.editorial_drafts[1];
    expect(copy).toMatchObject({ state: "draft", source_draft_id: SRC, source_task_id: "task-1", asset_ids: ["a1"], campaign_id: "camp", link_url: "https://shop.example" });
    expect(copy.name).toMatch(/^Tip of the week · \d{4}-\d{2}-\d{2}$/);
    expect(db.tables.editorial_variants.filter((v) => v.draft_id === copy.id)).toEqual([expect.objectContaining({ channel_id: "ch-li", body: "LI" })]);
    expect(db.tables.operator_notifications).toEqual([expect.objectContaining({ recipient_id: "owner", entity_id: copy.id, dedupe_key: "content-recur:task-1" })]);

    // Retried occurrence → same copy, nothing duplicated.
    expect(await contentRecurHandler.run!(ctx(db), { draftId: SRC })).toMatchObject({ result: { reused: true, draftId: copy.id } });
    expect(db.tables.editorial_drafts).toHaveLength(2);
  });

  it("skips completed/archived campaigns and stops terminally when the source is gone", async () => {
    const db = seed({ campaigns: [{ id: "camp", workspace_id: WS, status: "archived" }] });
    expect(await contentRecurHandler.run!(ctx(db), { draftId: SRC })).toMatchObject({ result: { skipped: "campaign_archived" } });
    expect(db.tables.editorial_drafts).toHaveLength(1);
    const empty = seed({ editorial_drafts: [] });
    await expect(contentRecurHandler.run!(ctx(empty), { draftId: SRC })).rejects.toMatchObject({ errorClass: "validation", options: { terminal: true } });
  });

  it("validates input and is schedulable through the generic schedule API", () => {
    expect(() => contentRecurHandler.parseInput({ draftId: "nope" })).toThrow(/content item id/);
    const s = parseScheduleInput({ name: "Repeat", kind: "content.recur", input: { draftId: SRC.toUpperCase() }, cron: "0 9 * * 1", timezone: "America/Toronto" }, new Date("2026-09-25T12:00:00Z"));
    expect(s).toMatchObject({ kind: "content.recur", input: { draftId: SRC }, execution_mode: "internal" });
  });

  it("names occurrences by local day without stacking suffixes", () => {
    const at = new Date("2026-10-01T02:00:00Z");
    expect(occurrenceName("Tip", at, "America/Toronto")).toBe("Tip · 2026-09-30");
    expect(occurrenceName("Tip · 2026-09-23", at, "UTC")).toBe("Tip · 2026-10-01");
    expect(occurrenceName("x".repeat(200), at, "Bad/Zone").length).toBe(200);
  });

  it("builds repeat cron expressions", () => {
    expect(repeatCron("daily", "09:30", 0, 1)).toBe("30 9 * * *");
    expect(repeatCron("weekly", "18:05", 5, 1)).toBe("5 18 * * 5");
    expect(repeatCron("monthly", "00:00", 0, 28)).toBe("0 0 28 * *");
    expect(repeatCron("monthly", "00:00", 0, 31)).toBeNull();
    expect(repeatCron("weekly", "25:00", 1, 1)).toBeNull();
  });
});

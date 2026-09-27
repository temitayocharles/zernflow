import "server-only";
import type { TaskHandler } from "@/lib/tasks/types";
import { TaskError } from "@/lib/tasks/errors";
import { InputError } from "@/lib/product/validation";

/**
 * `content.recur` (R4 deferred item): attached to a task schedule, each
 * occurrence materialises a fresh *draft* copy of a content item (body, kind,
 * link, UTM, assets, campaign and channel variants). Nothing is published or
 * scheduled automatically: the copy enters the normal review → approve →
 * schedule flow, and workspace owners are notified.
 *
 * Idempotent per occurrence: `editorial_drafts.source_task_id` is unique, so a
 * retried task never creates a second copy.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RecurInput extends Record<string, unknown> {
  draftId: string;
}

export function occurrenceName(name: string, at: Date, timeZone: string): string {
  let day: string;
  try {
    day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    day = at.toISOString().slice(0, 10);
  }
  const base = name.replace(/ · \d{4}-\d{2}-\d{2}$/, "");
  const suffix = ` · ${day}`;
  return `${base.slice(0, 200 - suffix.length)}${suffix}`;
}

export const contentRecurHandler: TaskHandler<RecurInput> = {
  kind: "content.recur",
  title: "Repeat content",
  description: "Creates a new draft copy of a content item (with its channel variants) for review and scheduling.",
  mode: "internal",
  schedulable: true,
  userRunnable: true,
  parseInput(input) {
    const v = (input ?? {}) as Record<string, unknown>;
    if (typeof v.draftId !== "string" || !UUID.test(v.draftId)) throw new InputError("draftId must be a content item id");
    return { draftId: v.draftId.toLowerCase() };
  },
  async run(ctx, input) {
    const { supabase, task } = ctx;
    const ws = task.workspace_id;

    const { data: existing } = await supabase.from("editorial_drafts").select("id").eq("workspace_id", ws).eq("source_task_id", task.id).maybeSingle();
    if (existing) return { status: "completed", result: { draftId: existing.id, reused: true } };

    const { data: src, error } = await supabase
      .from("editorial_drafts")
      .select("id, name, body, kind, link_url, utm, asset_ids, campaign_id, timezone")
      .eq("workspace_id", ws)
      .eq("id", input.draftId)
      .maybeSingle();
    if (error) throw new TaskError("transient", `content lookup failed: ${error.code ?? "unknown"}`);
    if (!src) throw new TaskError("validation", "The source content item was deleted; disable or delete this schedule.", { terminal: true });

    if (src.campaign_id) {
      const { data: campaign } = await supabase.from("campaigns").select("status").eq("workspace_id", ws).eq("id", src.campaign_id).maybeSingle();
      if (campaign && ["completed", "archived"].includes(campaign.status)) {
        return { status: "completed", result: { skipped: `campaign_${campaign.status}` } };
      }
    }

    // Only assets that are still available are carried over (the asset check trigger rejects others).
    let assetIds: string[] = src.asset_ids ?? [];
    if (assetIds.length) {
      const { data: live } = await supabase.from("artifacts").select("id").eq("workspace_id", ws).eq("status", "available").in("id", assetIds);
      const ok = new Set((live ?? []).map((a) => a.id));
      assetIds = assetIds.filter((id) => ok.has(id));
    }

    const { data: copy, error: insErr } = await supabase
      .from("editorial_drafts")
      .insert({
        workspace_id: ws,
        name: occurrenceName(src.name, new Date(), src.timezone || "UTC"),
        body: src.body,
        kind: src.kind,
        link_url: src.link_url,
        utm: src.utm,
        asset_ids: assetIds,
        campaign_id: src.campaign_id,
        timezone: src.timezone,
        state: "draft",
        source_draft_id: src.id,
        source_task_id: task.id,
      })
      .select("id, name")
      .single();
    if (insErr?.code === "23505") {
      const { data: raced } = await supabase.from("editorial_drafts").select("id").eq("workspace_id", ws).eq("source_task_id", task.id).maybeSingle();
      if (raced) return { status: "completed", result: { draftId: raced.id, reused: true } };
    }
    if (insErr || !copy) throw new TaskError("transient", `could not create the content copy: ${insErr?.code ?? "no row"}`);

    const { data: variants } = await supabase.from("editorial_variants").select("channel_id, body, media_refs").eq("workspace_id", ws).eq("draft_id", src.id);
    const { data: channels } = variants?.length
      ? await supabase.from("channels").select("id").eq("workspace_id", ws).eq("is_active", true).in("id", variants.map((v) => v.channel_id))
      : { data: [] as { id: string }[] };
    const active = new Set((channels ?? []).map((c) => c.id));
    const rows = (variants ?? []).filter((v) => active.has(v.channel_id)).map((v) => ({ workspace_id: ws, draft_id: copy.id, channel_id: v.channel_id, body: v.body, media_refs: v.media_refs }));
    if (rows.length) {
      const { error: vErr } = await supabase.from("editorial_variants").insert(rows);
      if (vErr) throw new TaskError("transient", `could not copy channel variants: ${vErr.code ?? "unknown"}`);
    }

    const { data: owners } = await supabase.from("workspace_members").select("user_id").eq("workspace_id", ws).eq("role", "owner");
    if (owners?.length) {
      await supabase.from("operator_notifications").upsert(
        owners.map((o) => ({
          workspace_id: ws,
          recipient_id: o.user_id,
          title: `New recurring draft ready for review: ${copy.name}`.slice(0, 300),
          kind: "content_recurred",
          entity_type: "editorial_drafts",
          entity_id: copy.id,
          dedupe_key: `content-recur:${task.id}`,
        })),
        { onConflict: "workspace_id,recipient_id,dedupe_key", ignoreDuplicates: true },
      );
    }
    await ctx.event("info", "Created recurring draft", { draftId: copy.id, variants: rows.length, droppedVariants: (variants?.length ?? 0) - rows.length });
    return { status: "completed", result: { draftId: copy.id, variants: rows.length, droppedAssets: (src.asset_ids?.length ?? 0) - assetIds.length } };
  },
};

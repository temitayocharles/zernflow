import "server-only";
import type { ServiceClient } from "@/lib/tasks/types";
import type { PublishState } from "@/lib/product/types";
import { PUBLISH_POLL_STEP } from "./engine";

/**
 * Keeps variant publish state consistent with its durable task (covers
 * operator cancellations in Jobs, remote-worker crashes, lease recovery).
 * Bounded; idempotent; only walks legal transitions.
 */
export async function reconcilePublishing(supabase: ServiceClient, limit = 200) {
  const { data: variants, error } = await supabase
    .from("editorial_variants")
    .select("id, workspace_id, publish_state, task_id, execution_mode, last_error")
    .in("publish_state", ["scheduled", "queued", "publishing"])
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`publish reconcile scan failed: ${error.code ?? "unknown"}`);
  if (!variants?.length) return { checked: 0, updated: 0 };
  const taskIds = variants.map((v) => v.task_id).filter((id): id is string => Boolean(id));
  const { data: tasks } = taskIds.length
    ? await supabase.from("tasks").select("id, state, result, error, intervention_reason, current_step").in("id", taskIds)
    : { data: [] as { id: string; state: string; result: unknown; error: unknown; intervention_reason: string | null; current_step: string | null }[] };
  const byId = new Map((tasks ?? []).map((t) => [t.id, t]));

  let updated = 0;
  const set = async (v: { id: string; workspace_id: string }, patch: Record<string, unknown>) => {
    const { error: e } = await supabase.from("editorial_variants").update(patch).eq("id", v.id).eq("workspace_id", v.workspace_id);
    if (!e) updated++;
  };
  for (const v of variants) {
    const state = v.publish_state as PublishState;
    const t = v.task_id ? byId.get(v.task_id) : undefined;
    const errMsg = (t?.error as { message?: string } | null)?.message ?? null;
    if (!t) {
      await set(v, { publish_state: "failed", last_error: "Publishing job is missing; reschedule this variant." });
    } else if (t.state === "running" && state !== "publishing") {
      await set(v, { publish_state: "publishing" });
    } else if (t.state === "waiting" && state === "publishing" && t.current_step?.startsWith(PUBLISH_POLL_STEP)) {
      // Accepted by the provider and being polled (R10): the post may go live at any moment.
      continue;
    } else if ((t.state === "retrying" || t.state === "waiting") && state === "publishing") {
      await set(v, { publish_state: "queued", last_error: errMsg });
    } else if (t.state === "waiting_for_user" && v.last_error !== (t.intervention_reason ?? errMsg)) {
      await set(v, { ...(state === "publishing" ? { publish_state: "queued" } : {}), last_error: (t.intervention_reason ?? errMsg ?? "Needs operator action").slice(0, 1000) });
    } else if (t.state === "failed") {
      await set(v, { publish_state: "failed", last_error: (errMsg ?? "Publishing failed").slice(0, 1000) });
    } else if (t.state === "cancelled") {
      await set(v, { publish_state: "cancelled" });
    } else if (t.state === "completed") {
      const r = (t.result ?? {}) as { externalUrl?: string; externalRef?: string; skipped?: string };
      if (r.skipped) continue;
      if (state !== "publishing") await set(v, { publish_state: "publishing" });
      await set(v, {
        publish_state: "published",
        external_url: typeof r.externalUrl === "string" && r.externalUrl.startsWith("https://") ? r.externalUrl.slice(0, 2000) : null,
        external_ref: typeof r.externalRef === "string" ? r.externalRef.slice(0, 300) : null,
      });
    }
  }
  return { checked: variants.length, updated };
}

/**
 * Manual publications that are due: flag the job for operator action and
 * notify workspace owners once (dedupe key per task).
 */
export async function remindManualPublications(supabase: ServiceClient, now = new Date(), limit = 100) {
  const { data: due, error } = await supabase
    .from("tasks")
    .select("id, workspace_id, objective, subject_id, input")
    .eq("kind", "content.publish")
    .eq("execution_mode", "human")
    .eq("state", "queued")
    .eq("human_intervention", "none")
    .lte("next_run_at", now.toISOString())
    .limit(limit);
  if (error) throw new Error(`manual publish scan failed: ${error.code ?? "unknown"}`);
  if (!due?.length) return { due: 0, notified: 0 };
  const workspaceIds = [...new Set(due.map((t) => t.workspace_id))];
  const { data: owners } = await supabase.from("workspace_members").select("workspace_id, user_id").in("workspace_id", workspaceIds).eq("role", "owner");
  let notified = 0;
  for (const t of due) {
    const { error: flagError } = await supabase
      .from("tasks")
      .update({ human_intervention: "requested", intervention_reason: "Publish this post on the platform, then confirm its link in Content." })
      .eq("id", t.id)
      .eq("state", "queued")
      .eq("human_intervention", "none");
    if (flagError) continue;
    const draftId = (t.input as { draftId?: string } | null)?.draftId;
    const rows = (owners ?? [])
      .filter((o) => o.workspace_id === t.workspace_id)
      .map((o) => ({
        workspace_id: t.workspace_id,
        recipient_id: o.user_id,
        title: `Due to publish: ${t.objective}`.slice(0, 300),
        kind: "manual_publish_due",
        entity_type: draftId ? "editorial_drafts" : "tasks",
        entity_id: draftId ?? t.id,
        dedupe_key: `manual-publish:${t.id}`,
      }));
    if (rows.length) {
      await supabase.from("operator_notifications").upsert(rows, { onConflict: "workspace_id,recipient_id,dedupe_key", ignoreDuplicates: true });
      notified += rows.length;
    }
  }
  return { due: due.length, notified };
}

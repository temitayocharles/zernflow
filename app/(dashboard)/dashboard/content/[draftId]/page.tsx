import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/workspace";
import { ContentForm } from "@/components/campaigns/content-form";
import { ConfirmPublication, ReconcilePublication, RepeatContent, SchedulePanel, type ScheduleVariant } from "@/components/campaigns/schedule-panel";
import { EditorialVariants } from "@/components/product/editorial-variants";
import { ActionButton } from "@/components/ops/action-button";
import { loadPublishContext, variantIssues, variantText } from "@/lib/publishing/service";
import { availableModes, profileFor, resolveMode } from "@/lib/publishing/capabilities";
import { summarizePublishState } from "@/lib/publishing/compose";
import { RECEIPT_LABEL, RECEIPT_TONE, STATE_LABEL, STATE_TONE, channelLabel, receiptsByVariant } from "@/lib/publishing/display";
import type { ServiceClient } from "@/lib/tasks/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = ["scheduled", "queued", "publishing"];

export default async function ContentItemPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  if (!UUID.test(draftId)) notFound();
  const { supabase, workspace, role } = await getWorkspace();
  const ctx = await loadPublishContext(supabase as unknown as ServiceClient, workspace.id, draftId);
  if (!ctx) notFound();
  const { draft, campaign } = ctx;
  const variantIds = ctx.variants.map((v) => v.id);
  const [{ data: channels }, { data: campaigns }, { data: assets }, { data: activity }, { data: receiptRows }, { data: repeats }] = await Promise.all([
    supabase.from("channels").select("id, platform, display_name, username").eq("workspace_id", workspace.id),
    supabase.from("campaigns").select("id, name").eq("workspace_id", workspace.id).neq("status", "archived").order("name").limit(500),
    supabase.from("artifacts").select("id, file_name").eq("workspace_id", workspace.id).eq("status", "available").in("kind", ["image", "video"]).order("created_at", { ascending: false }).limit(200),
    supabase.from("product_activity").select("id, action, actor_id, created_at").eq("workspace_id", workspace.id).eq("entity_type", "editorial_drafts").eq("entity_id", draftId).order("created_at", { ascending: false }).limit(30),
    variantIds.length
      ? supabase.from("publish_receipts").select("id, variant_id, idempotency_key, attempt, mode, provider, status, operation_ref, external_url, error_class, error_message, created_at, settled_at").eq("workspace_id", workspace.id).in("variant_id", variantIds).order("created_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [] }),
    supabase.from("task_schedules").select("id, name, cron, timezone, enabled, next_run_at").eq("workspace_id", workspace.id).eq("kind", "content.recur").eq("input->>draftId", draftId).limit(20),
  ]);
  const receipts = receiptsByVariant(receiptRows ?? [], ctx.variants);
  const summary = summarizePublishState(ctx.variants.map((v) => v.publish_state));
  const locked = ctx.variants.some((v) => ACTIVE.includes(v.publish_state));
  const isOwner = role === "owner";
  const approvalNeeded = campaign?.requires_approval ?? false;
  const canSchedule = draft.state === "approved" || (!approvalNeeded && isOwner);
  const blockedReason = canSchedule ? undefined : approvalNeeded ? "This campaign requires approval before scheduling." : "Only owners can schedule unapproved content.";
  const usedChannels = new Set(ctx.variants.map((v) => v.channel_id));
  const channelOptions = (channels ?? []).filter((c) => !usedChannels.has(c.id)).map((c) => ({ id: c.id, label: channelLabel(c) }));
  const scheduleVariants: ScheduleVariant[] = ctx.variants.map((v) => {
    const resolved = resolveMode(v.platform, draft.kind, v.execution_mode ?? undefined);
    return {
      id: v.id, label: v.channelLabel, state: v.publish_state, issues: variantIssues(ctx, v),
      modes: availableModes(v.platform, draft.kind), defaultMode: "mode" in resolved ? resolved.mode : null,
    };
  });
  const editable = ctx.variants.filter((v) => !ACTIVE.includes(v.publish_state) && v.publish_state !== "published");
  return (
    <div className="space-y-6 p-6">
      <nav className="text-sm"><Link href="/dashboard/content" className="text-muted-foreground hover:underline">← Content</Link>
        {campaign && <> · <Link href={`/dashboard/campaigns/${campaign.id}`} className="text-muted-foreground hover:underline">{campaign.name}</Link></>}
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{draft.name}</h1>
          <p className="text-sm text-muted-foreground">
            <span className={`mr-2 rounded px-2 py-0.5 text-xs ${STATE_TONE[summary]}`}>{STATE_LABEL[summary]}</span>
            Review: <span className="capitalize">{draft.state.replace("_", " ")}</span>
            {draft.reviewed_at && <> · approved {new Date(draft.reviewed_at).toLocaleString()}</>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {draft.state === "draft" && !locked && <ActionButton url={`/api/v1/configuration/editorial_drafts/${draft.id}`} method="PATCH" body={{ version: draft.version, state: "in_review" }} label="Submit for review" />}
          {draft.state === "in_review" && isOwner && !locked && <ActionButton url={`/api/v1/configuration/editorial_drafts/${draft.id}`} method="PATCH" body={{ version: draft.version, state: "approved" }} label="Approve" variant="primary" />}
          {locked && <ActionButton url={`/api/v1/content/${draft.id}/unschedule`} label="Unschedule all" confirm="Cancel all pending publications for this content?" variant="danger" />}
        </div>
      </header>

      <section className="space-y-3" aria-labelledby="variants-h">
        <h2 id="variants-h" className="font-semibold">Channel variants</h2>
        {ctx.variants.length === 0 && <p className="text-sm text-muted-foreground">Add at least one channel variant to publish.</p>}
        <ul className="space-y-3">
          {ctx.variants.map((v) => {
            const preview = variantText(ctx, v);
            const issues = variantIssues(ctx, v);
            const profile = profileFor(v.platform);
            return (
              <li key={v.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{v.channelLabel}</span>
                  <span className="flex items-center gap-2 text-xs">
                    {v.execution_mode && <span className="text-muted-foreground">{v.execution_mode}</span>}
                    {v.scheduled_at && ACTIVE.includes(v.publish_state) && <span className="text-muted-foreground">{new Date(v.scheduled_at).toLocaleString()}</span>}
                    <span className={`rounded px-2 py-0.5 ${STATE_TONE[v.publish_state]}`}>{STATE_LABEL[v.publish_state]}</span>
                  </span>
                </div>
                <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-muted p-2 font-sans">{preview.text || <em className="text-muted-foreground">Empty</em>}</pre>
                {preview.trackedLink && (
                  <p className="mt-1 break-all text-xs text-muted-foreground">Tracked link{profile && !profile.supportsLinks ? " (not clickable on this platform — use bio or story link)" : ""}: {preview.trackedLink}</p>
                )}
                {issues.length > 0 && <ul className="mt-1 list-disc pl-5 text-destructive">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}
                {v.last_error && <p className="mt-1 text-destructive">Last error: {v.last_error}</p>}
                {v.external_url && <p className="mt-1"><a href={v.external_url} target="_blank" rel="noopener noreferrer" className="underline">View published post</a></p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {v.task_id && <Link href={`/dashboard/jobs/${v.task_id}`} className="text-xs underline">Job</Link>}
                  {["scheduled", "queued"].includes(v.publish_state) && <ActionButton url={`/api/v1/content/${draft.id}/unschedule`} body={{ variantId: v.id }} label="Unschedule" />}
                </div>
                {v.execution_mode === "manual" && ["scheduled", "queued"].includes(v.publish_state) && <ConfirmPublication variantId={v.id} />}
                {receipts[v.id]?.needsReconcile && (
                  <ReconcilePublication variantId={v.id} allowNotPublished={receipts[v.id]!.latest?.status === "unknown"} />
                )}
                {(receipts[v.id]?.all.length ?? 0) > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">Publish attempts ({receipts[v.id]!.all.length})</summary>
                    <ul className="mt-1 space-y-1 text-xs">
                      {receipts[v.id]!.all.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-2">
                          <span className={`rounded px-1.5 py-0.5 ${RECEIPT_TONE[r.status]}`}>{RECEIPT_LABEL[r.status]}</span>
                          <span>#{r.attempt} · {r.mode} · {r.provider}</span>
                          <span className="text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span>
                          {r.error_class && <span className="text-destructive">{r.error_class}{r.error_message ? `: ${r.error_message}` : ""}</span>}
                          {r.external_url && <a href={r.external_url} target="_blank" rel="noopener noreferrer" className="underline">post</a>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Edit variants</summary>
          <div className="mt-3">
            <EditorialVariants draftId={draft.id} channels={channelOptions} variants={editable} />
          </div>
        </details>
      </section>

      <section className="space-y-3 rounded-lg border border-border p-4" aria-labelledby="schedule-h">
        <h2 id="schedule-h" className="font-semibold">Schedule</h2>
        <p className="text-xs text-muted-foreground">Each variant publishes through the best available route: a connected provider API, a managed browser session, or a manual reminder where you post and confirm the link. Unsupported routes are shown but cannot be selected.</p>
        <SchedulePanel draftId={draft.id} variants={scheduleVariants} canSchedule={canSchedule} blockedReason={blockedReason} defaultAt={draft.scheduled_at} />
      </section>

      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer font-medium">Repeat{(repeats ?? []).length ? ` (${(repeats ?? []).length} active schedule${(repeats ?? []).length === 1 ? "" : "s"})` : ""}</summary>
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-muted-foreground">Each occurrence creates a new draft copy of this content (with its channel variants) for review and scheduling. Nothing is published automatically.</p>
          {draft.source_draft_id && <p>This item is a copy of <Link href={`/dashboard/content/${draft.source_draft_id}`} className="underline">its source content</Link>.</p>}
          {(repeats ?? []).length > 0 && (
            <ul className="space-y-1">
              {(repeats ?? []).map((r) => (
                <li key={r.id}>{r.enabled ? "Active" : "Paused"} · <code>{r.cron}</code> ({r.timezone}) · next {new Date(r.next_run_at).toLocaleString()}</li>
              ))}
            </ul>
          )}
          {isOwner ? <RepeatContent draftId={draft.id} draftName={draft.name} /> : <p className="text-muted-foreground">Only owners can create repeats.</p>}
          <p><Link href="/dashboard/jobs/schedules" className="underline">Manage schedules</Link></p>
        </div>
      </details>

      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer font-medium">Edit content</summary>
        <div className="mt-3">
          <ContentForm draft={draft} campaigns={campaigns ?? []} assets={(assets ?? []).map((a) => ({ id: a.id, label: a.file_name || a.id }))} locked={locked} />
        </div>
      </details>

      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer font-medium">Activity (latest 30)</summary>
        <ul className="mt-2 space-y-1 text-sm">
          {(activity ?? []).map((a) => (
            <li key={a.id}>{a.action} · <span className="text-muted-foreground">{a.actor_id ? (a.actor_id === draft.created_by ? "creator" : "member") : "system"} · {new Date(a.created_at).toLocaleString()}</span></li>
          ))}
          {(activity ?? []).length === 0 && <li className="text-muted-foreground">No activity recorded.</li>}
        </ul>
      </details>
    </div>
  );
}

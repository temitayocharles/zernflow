"use client";
import type { CampaignRow } from "@/lib/types/platform";
import { inputClass, isoToLocal, localToIso, useJsonSubmit } from "./use-submit";

const OBJECTIVES = [
  ["awareness", "Awareness"], ["engagement", "Engagement"], ["lead_generation", "Lead generation"],
  ["sales", "Sales"], ["launch", "Launch"], ["community", "Community"], ["other", "Other"],
] as const;

/** Create (no campaign) or edit (campaign given) a campaign. */
export function CampaignForm({ campaign, channels }: { campaign?: CampaignRow; channels: { id: string; label: string }[] }) {
  const { busy, error, submit, router } = useJsonSubmit();
  const utm = (campaign?.utm_defaults ?? {}) as Record<string, string>;
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const body: Record<string, unknown> = {
          name: f.get("name"),
          objective: f.get("objective"),
          voice: String(f.get("voice") ?? ""),
          notes: String(f.get("notes") ?? ""),
          channel_ids: f.getAll("channel_ids"),
          starts_at: localToIso(f.get("starts_at")),
          ends_at: localToIso(f.get("ends_at")),
          requires_approval: f.get("requires_approval") === "on",
          audience: { description: String(f.get("audience") ?? "") },
          utm_defaults: { utm_source: f.get("utm_source") || undefined, utm_medium: f.get("utm_medium") || undefined, utm_campaign: f.get("utm_campaign") || undefined },
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
        if (campaign) body.version = campaign.version;
        const out = await submit<{ campaign?: CampaignRow }>(campaign ? `/api/v1/campaigns/${campaign.id}` : "/api/v1/campaigns", campaign ? "PATCH" : "POST", body);
        if (!campaign && out?.campaign) router.push(`/dashboard/campaigns/${out.campaign.id}`);
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">Name<input name="name" required maxLength={200} defaultValue={campaign?.name} className={inputClass} /></label>
        <label className="block text-sm">Objective
          <select name="objective" defaultValue={campaign?.objective ?? "awareness"} className={inputClass}>
            {OBJECTIVES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="block text-sm">Starts<input type="datetime-local" name="starts_at" defaultValue={isoToLocal(campaign?.starts_at)} className={inputClass} /></label>
        <label className="block text-sm">Ends<input type="datetime-local" name="ends_at" defaultValue={isoToLocal(campaign?.ends_at)} className={inputClass} /></label>
      </div>
      <label className="block text-sm">Audience<textarea name="audience" maxLength={4000} rows={2} defaultValue={String((campaign?.audience as { description?: string } | null)?.description ?? "")} className={inputClass} placeholder="Who is this campaign for?" /></label>
      <label className="block text-sm">Voice and guidelines<textarea name="voice" maxLength={20000} rows={3} defaultValue={campaign?.voice ?? ""} className={inputClass} placeholder="Tone, words to use or avoid, claims that need review…" /></label>
      <fieldset className="text-sm">
        <legend>Channels</legend>
        {channels.length === 0 && <p className="text-muted-foreground">No connected channels yet.</p>}
        <div className="mt-1 flex flex-wrap gap-3">
          {channels.map((c) => (
            <label key={c.id} className="inline-flex items-center gap-1">
              <input type="checkbox" name="channel_ids" value={c.id} defaultChecked={campaign?.channel_ids.includes(c.id)} /> {c.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="grid gap-3 text-sm md:grid-cols-3">
        <legend className="mb-1">Default tracking (UTM); per-channel source is filled automatically when empty</legend>
        <label>Source<input name="utm_source" maxLength={200} defaultValue={utm.source ?? ""} className={inputClass} /></label>
        <label>Medium<input name="utm_medium" maxLength={200} defaultValue={utm.medium ?? ""} className={inputClass} placeholder="social" /></label>
        <label>Campaign<input name="utm_campaign" maxLength={200} defaultValue={utm.campaign ?? ""} className={inputClass} placeholder="from name" /></label>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="requires_approval" defaultChecked={campaign?.requires_approval ?? true} /> Content must be approved before it can be scheduled
      </label>
      <label className="block text-sm">Notes<textarea name="notes" maxLength={20000} rows={2} defaultValue={campaign?.notes ?? ""} className={inputClass} /></label>
      <button disabled={busy} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
        {busy ? "Saving…" : campaign ? "Save campaign" : "Create campaign"}
      </button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  );
}

const NEXT: Record<string, [string, string][]> = {
  draft: [["planned", "Mark planned"], ["active", "Activate"]],
  planned: [["active", "Activate"], ["draft", "Back to draft"]],
  active: [["paused", "Pause"], ["completed", "Complete"]],
  paused: [["active", "Resume"], ["completed", "Complete"]],
  completed: [["active", "Reopen"]],
  archived: [["draft", "Restore"]],
};

export function CampaignStatusActions({ campaign, isOwner }: { campaign: CampaignRow; isOwner: boolean }) {
  const { busy, error, submit } = useJsonSubmit();
  const options = [...(NEXT[campaign.status] ?? []), ...(isOwner && campaign.status !== "archived" ? ([["archived", "Archive"]] as [string, string][]) : [])];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.map(([status, label]) => (
        <button key={status} disabled={busy} onClick={() => submit(`/api/v1/campaigns/${campaign.id}`, "PATCH", { status, version: campaign.version })}
          className={`rounded border px-2 py-1 text-sm disabled:opacity-50 ${status === "archived" ? "border-destructive text-destructive" : "border-border hover:bg-accent"}`}>
          {label}
        </button>
      ))}
      {error && <span role="alert" className="text-sm text-destructive">{error}</span>}
    </div>
  );
}

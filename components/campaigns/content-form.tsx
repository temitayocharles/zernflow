"use client";
import type { EditorialDraft } from "@/lib/product/types";
import { inputClass, useJsonSubmit } from "./use-submit";

const KINDS = [["post", "Post"], ["short_video", "Short video"], ["reel", "Reel"], ["story", "Story"], ["carousel", "Carousel"], ["thread", "Thread"], ["article", "Article"]] as const;

/** Create or edit a content item (the shared brief; per-channel copy lives in variants). */
export function ContentForm({
  draft, campaigns, assets, defaultCampaignId, locked,
}: {
  draft?: EditorialDraft;
  campaigns: { id: string; name: string }[];
  assets: { id: string; label: string }[];
  defaultCampaignId?: string;
  locked?: boolean;
}) {
  const { busy, error, submit, router } = useJsonSubmit();
  const utm = draft?.utm ?? {};
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const body: Record<string, unknown> = {
          name: f.get("name"),
          body: String(f.get("body") ?? ""),
          kind: f.get("kind"),
          campaign_id: f.get("campaign_id") || null,
          link_url: String(f.get("link_url") ?? "").trim() || null,
          utm: { campaign: f.get("utm_campaign") || null, content: f.get("utm_content") || null, term: f.get("utm_term") || null },
          asset_ids: f.getAll("asset_ids"),
        };
        if (draft) body.version = draft.version;
        const out = await submit<{ id?: string }>(`/api/v1/configuration/editorial_drafts${draft ? `/${draft.id}` : ""}`, draft ? "PATCH" : "POST", body);
        if (!draft && out?.id) router.push(`/dashboard/content/${out.id}`);
      }}
    >
      <fieldset disabled={locked} className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="block text-sm md:col-span-2">Title<input name="name" required maxLength={200} defaultValue={draft?.name} className={inputClass} /></label>
          <label className="block text-sm">Format
            <select name="kind" defaultValue={draft?.kind ?? "post"} className={inputClass}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        </div>
        <label className="block text-sm">Campaign
          <select name="campaign_id" defaultValue={draft?.campaign_id ?? defaultCampaignId ?? ""} className={inputClass}>
            <option value="">No campaign</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">Base copy (used when a channel variant is empty)<textarea name="body" rows={4} maxLength={100000} defaultValue={draft?.body} className={inputClass} /></label>
        <label className="block text-sm">Link (tracking parameters are added per channel)<input name="link_url" type="url" maxLength={2000} defaultValue={draft?.link_url ?? ""} placeholder="https://" className={inputClass} /></label>
        <fieldset className="grid gap-3 text-sm md:grid-cols-3">
          <legend className="mb-1">Tracking overrides (optional)</legend>
          <label>utm_campaign<input name="utm_campaign" maxLength={200} defaultValue={utm.campaign ?? ""} className={inputClass} /></label>
          <label>utm_content<input name="utm_content" maxLength={200} defaultValue={utm.content ?? ""} className={inputClass} /></label>
          <label>utm_term<input name="utm_term" maxLength={200} defaultValue={utm.term ?? ""} className={inputClass} /></label>
        </fieldset>
        <fieldset className="text-sm">
          <legend>Media from Assets (maximum 20)</legend>
          {assets.length === 0 ? (
            <p className="text-muted-foreground">No available images or videos. Upload them in Assets.</p>
          ) : (
            <div className="mt-1 grid max-h-48 gap-1 overflow-auto md:grid-cols-2">
              {assets.map((a) => (
                <label key={a.id} className="inline-flex items-center gap-2 truncate">
                  <input type="checkbox" name="asset_ids" value={a.id} defaultChecked={draft?.asset_ids.includes(a.id)} /> {a.label}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <button disabled={busy} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
          {busy ? "Saving…" : draft ? "Save content" : "Create content"}
        </button>
      </fieldset>
      {locked && <p className="text-sm text-muted-foreground">Unschedule this content to edit it.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  );
}

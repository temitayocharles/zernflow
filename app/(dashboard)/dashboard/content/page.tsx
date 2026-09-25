import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { ContentForm } from "@/components/campaigns/content-form";
import { summarizePublishState, type ContentPublishSummary } from "@/lib/publishing/compose";
import { STATE_LABEL, STATE_TONE } from "@/lib/publishing/display";
import type { PublishState } from "@/lib/product/types";

const PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string; name: string; state: string; kind: string; campaign_id: string | null; updated_at: string;
  editorial_variants: { publish_state: PublishState; scheduled_at: string | null }[] | null;
};

export default async function ContentPage({ searchParams }: { searchParams: Promise<{ campaign?: string; state?: string; page?: string; new?: string }> }) {
  const sp = await searchParams;
  const { supabase, workspace } = await getWorkspace();
  const campaignFilter = sp.campaign && UUID.test(sp.campaign) ? sp.campaign : null;
  const page = Math.max(1, Number(sp.page) || 1);
  let q = supabase
    .from("editorial_drafts")
    .select("id, name, state, kind, campaign_id, updated_at, editorial_variants(publish_state, scheduled_at)", { count: "exact" })
    .eq("workspace_id", workspace.id)
    .order("updated_at", { ascending: false })
    .range((page - 1) * PAGE, page * PAGE - 1);
  if (campaignFilter) q = q.eq("campaign_id", campaignFilter);
  const [{ data, count, error }, { data: campaigns }, { data: assets }] = await Promise.all([
    q,
    supabase.from("campaigns").select("id, name").eq("workspace_id", workspace.id).neq("status", "archived").order("name").limit(500),
    supabase.from("artifacts").select("id, file_name, content_type").eq("workspace_id", workspace.id).eq("status", "available").in("kind", ["image", "video"]).order("created_at", { ascending: false }).limit(200),
  ]);
  const rows = ((data ?? []) as unknown as Row[]).map((r) => ({ ...r, summary: summarizePublishState((r.editorial_variants ?? []).map((v) => v.publish_state)) }));
  const stateFilter = sp.state as ContentPublishSummary | undefined;
  const visible = stateFilter && stateFilter in STATE_LABEL ? rows.filter((r) => r.summary === stateFilter) : rows;
  const campaignName = new Map((campaigns ?? []).map((c) => [c.id, c.name]));
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const href = (extra: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const merged = { campaign: campaignFilter, state: stateFilter ?? null, page: null, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v !== null && v !== undefined && v !== "") p.set(k, String(v));
    const s = p.toString();
    return `/dashboard/content${s ? `?${s}` : ""}`;
  };
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Content</h1>
          <p className="text-sm text-muted-foreground">Posts and videos with per-channel variants, approval and scheduling.</p>
        </div>
        <Link href="/dashboard/calendar" className="rounded border border-border px-2 py-1 text-sm hover:bg-accent">Calendar</Link>
      </header>
      <form className="flex flex-wrap items-end gap-2 text-sm" action="/dashboard/content">
        <label>Campaign
          <select name="campaign" defaultValue={campaignFilter ?? ""} className="ml-2 rounded border border-border bg-background p-1">
            <option value="">All</option>
            {(campaigns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Status
          <select name="state" defaultValue={stateFilter ?? ""} className="ml-2 rounded border border-border bg-background p-1">
            <option value="">All</option>
            {Object.entries(STATE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <button className="rounded border border-border px-2 py-1">Filter</button>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">Content is unavailable. Confirm migration 00033 is applied.</p>}
      {visible.length === 0 && !error ? <p className="text-sm text-muted-foreground">No content matches.</p> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground"><tr><th className="p-2">Title</th><th className="p-2">Campaign</th><th className="p-2">Review</th><th className="p-2">Next publish</th><th className="p-2">Status</th></tr></thead>
          <tbody className="divide-y divide-border">
            {visible.map((r) => {
              const next = (r.editorial_variants ?? []).filter((v) => ["scheduled", "queued"].includes(v.publish_state)).map((v) => v.scheduled_at).filter(Boolean).sort()[0];
              return (
                <tr key={r.id}>
                  <td className="p-2"><Link href={`/dashboard/content/${r.id}`} className="hover:underline">{r.name}</Link> <span className="text-xs text-muted-foreground">{r.kind.replace("_", " ")}</span></td>
                  <td className="p-2">{r.campaign_id ? <Link href={`/dashboard/campaigns/${r.campaign_id}`} className="hover:underline">{campaignName.get(r.campaign_id) ?? "Campaign"}</Link> : <span className="text-muted-foreground">—</span>}</td>
                  <td className="p-2 capitalize">{r.state.replace("_", " ")}</td>
                  <td className="p-2">{next ? new Date(next).toLocaleString() : "—"}</td>
                  <td className="p-2"><span className={`rounded px-2 py-0.5 text-xs ${STATE_TONE[r.summary]}`}>{STATE_LABEL[r.summary]}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {pages > 1 && (
        <nav aria-label="Pages" className="flex gap-3 text-sm">
          {page > 1 && <Link href={href({ page: page - 1 })}>← Newer</Link>}
          <span className="text-muted-foreground">Page {page} of {pages}</span>
          {page < pages && <Link href={href({ page: page + 1 })}>Older →</Link>}
        </nav>
      )}
      <details open={sp.new === "1"} className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer font-medium">New content</summary>
        <div className="mt-3">
          <ContentForm campaigns={campaigns ?? []} defaultCampaignId={campaignFilter ?? undefined} assets={(assets ?? []).map((a) => ({ id: a.id, label: a.file_name || a.id }))} />
        </div>
      </details>
    </div>
  );
}

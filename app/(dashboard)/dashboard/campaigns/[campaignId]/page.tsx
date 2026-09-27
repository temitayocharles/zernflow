import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/workspace";
import { CampaignForm, CampaignStatusActions } from "@/components/campaigns/campaign-form";
import { CAMPAIGN_STATUS_TONE, STATE_LABEL, STATE_TONE, channelLabel } from "@/lib/publishing/display";
import { summarizePublishState } from "@/lib/publishing/compose";
import type { PublishState } from "@/lib/product/types";
import type { CampaignEngagementRow, CampaignRow } from "@/lib/types/platform";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CampaignPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  if (!UUID.test(campaignId)) notFound();
  const { supabase, workspace, role } = await getWorkspace();
  const { data } = await supabase.from("campaigns").select("*").eq("workspace_id", workspace.id).eq("id", campaignId).maybeSingle();
  if (!data) notFound();
  const campaign = data as CampaignRow;
  const [{ data: channels }, { data: drafts }, { data: tasks }, { data: engagementRows, error: engagementError }, { data: touches }] = await Promise.all([
    supabase.from("channels").select("id, platform, display_name, username").eq("workspace_id", workspace.id),
    supabase.from("editorial_drafts").select("id, name, state, kind, editorial_variants(publish_state, scheduled_at)").eq("workspace_id", workspace.id).eq("campaign_id", campaignId).order("created_at", { ascending: false }).limit(200),
    supabase.from("tasks").select("id, objective, state, next_run_at").eq("workspace_id", workspace.id).eq("campaign_id", campaignId).order("created_at", { ascending: false }).limit(20),
    supabase.rpc("campaign_engagement", { p_workspace: workspace.id, p_since: "2000-01-01T00:00:00Z" }),
    supabase.from("contact_touchpoints").select("id, contact_id, source, occurred_at").eq("workspace_id", workspace.id).eq("campaign_id", campaignId).order("occurred_at", { ascending: false }).limit(15),
  ]);
  const engagement = ((engagementRows ?? []) as CampaignEngagementRow[]).find((r) => r.campaign_id === campaignId);
  const touchContactIds = [...new Set((touches ?? []).map((t) => t.contact_id))];
  const { data: touchContacts } = touchContactIds.length
    ? await supabase.from("contacts").select("id, display_name, email").eq("workspace_id", workspace.id).in("id", touchContactIds)
    : { data: [] as { id: string; display_name: string | null; email: string | null }[] };
  const contactName = new Map((touchContacts ?? []).map((c) => [c.id, c.display_name || c.email || "Contact"]));
  const channelOptions = (channels ?? []).map((c) => ({ id: c.id, label: channelLabel(c) }));
  const results = (campaign.results ?? {}) as Record<string, unknown>;
  type DraftRow = { id: string; name: string; state: string; kind: string; editorial_variants: { publish_state: PublishState; scheduled_at: string | null }[] | null };
  const rows = (drafts ?? []) as unknown as DraftRow[];
  const tally = { published: 0, scheduled: 0, failed: 0 };
  for (const d of rows) for (const v of d.editorial_variants ?? []) {
    if (v.publish_state === "published") tally.published++;
    else if (["scheduled", "queued", "publishing"].includes(v.publish_state)) tally.scheduled++;
    else if (v.publish_state === "failed") tally.failed++;
  }
  return (
    <div className="space-y-6 p-6">
      <nav className="text-sm"><Link href="/dashboard/campaigns" className="text-muted-foreground hover:underline">← Campaigns</Link></nav>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{campaign.name}</h1>
          <p className="text-sm capitalize text-muted-foreground">
            <span className={`mr-2 rounded px-2 py-0.5 text-xs ${CAMPAIGN_STATUS_TONE[campaign.status] ?? ""}`}>{campaign.status}</span>
            {campaign.objective.replace("_", " ")} · {campaign.requires_approval ? "approval required" : "no approval step"}
          </p>
        </div>
        <CampaignStatusActions campaign={campaign} isOwner={role === "owner"} />
      </header>
      <section aria-label="Results" className="grid gap-3 sm:grid-cols-4">
        {[["Content items", rows.length], ["Posts published", tally.published], ["Posts scheduled", tally.scheduled], ["Posts failed", tally.failed]].map(([l, v]) => (
          <div key={String(l)} className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{l}</p><p className="text-xl font-semibold">{v}</p></div>
        ))}
      </section>
      <section aria-label="Engagement and attribution" className="space-y-2">
        <h2 className="font-semibold">Engagement and leads</h2>
        {engagementError ? (
          <p className="text-sm text-muted-foreground">Attribution unavailable. Apply migration 00036.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                ["Comments on campaign posts", engagement?.comments ?? 0],
                ["Unique commenters", engagement?.commenters ?? 0],
                ["Attributed contacts", engagement?.contacts ?? 0],
                ["New leads (first touch)", engagement?.first_touch_contacts ?? 0],
              ].map(([l, v]) => (
                <div key={String(l)} className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{l}</p><p className="text-xl font-semibold">{Number(v)}</p></div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Comments are counted on posts whose platform post ID is known (API publishing, or manual publishing confirmed with the post ID).
              Leads come from comment automations, lead intake with a matching <code>utm_campaign</code>, and manual attribution.
            </p>
            {(touches ?? []).length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {(touches ?? []).map((t) => (
                  <li key={t.id} className="flex justify-between gap-2 p-2">
                    <Link href={`/dashboard/contacts/${t.contact_id}`} className="hover:underline">{contactName.get(t.contact_id) ?? "Contact"}</Link>
                    <span className="text-xs text-muted-foreground">{t.source} · {new Date(t.occurred_at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
      {Object.keys(results).length > 0 && <p className="text-xs text-muted-foreground">Recorded results: {Object.entries(results).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</p>}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Content</h2>
          <Link href={`/dashboard/content?new=1&campaign=${campaign.id}`} className="rounded border border-border px-2 py-1 text-sm hover:bg-accent">New content</Link>
        </div>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No content in this campaign yet.</p> : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rows.map((d) => {
              const s = summarizePublishState((d.editorial_variants ?? []).map((v) => v.publish_state));
              const next = (d.editorial_variants ?? []).map((v) => v.scheduled_at).filter(Boolean).sort()[0];
              return (
                <li key={d.id} className="flex items-center justify-between gap-2 p-3 text-sm">
                  <Link href={`/dashboard/content/${d.id}`} className="hover:underline">{d.name}</Link>
                  <span className="flex items-center gap-2 text-xs">
                    {next && <span className="text-muted-foreground">{new Date(next).toLocaleString()}</span>}
                    <span className="text-muted-foreground">{d.state.replace("_", " ")}</span>
                    <span className={`rounded px-2 py-0.5 ${STATE_TONE[s]}`}>{STATE_LABEL[s]}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {(tasks ?? []).length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Recent jobs</h2>
          <ul className="text-sm">
            {(tasks ?? []).map((t) => (
              <li key={t.id}><Link href={`/dashboard/jobs/${t.id}`} className="hover:underline">{t.objective}</Link> <span className="text-xs text-muted-foreground">{t.state}</span></li>
            ))}
          </ul>
        </section>
      )}
      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer font-medium">Edit campaign</summary>
        <div className="mt-3"><CampaignForm campaign={campaign} channels={channelOptions} /></div>
      </details>
    </div>
  );
}

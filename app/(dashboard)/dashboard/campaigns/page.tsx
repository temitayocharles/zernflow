import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { CampaignForm } from "@/components/campaigns/campaign-form";
import { CAMPAIGN_STATUS_TONE, channelLabel } from "@/lib/publishing/display";
import { ActionButton } from "@/components/ops/action-button";
import { CreateIntakeTokenForm } from "@/components/campaigns/lead-intake";
import type { CampaignEngagementRow, CampaignRow } from "@/lib/types/platform";

const FILTERS = ["active", "planned", "draft", "paused", "completed", "archived"] as const;

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { supabase, workspace, role } = await getWorkspace();
  const isOwner = role === "owner";
  const requested = (await searchParams).status;
  const status = FILTERS.find((s) => s === requested) ?? null;
  let q = supabase.from("campaigns").select("*").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(200);
  q = status ? q.eq("status", status) : q.neq("status", "archived");
  const [{ data, error }, { data: channels }, { data: drafts }, { data: engagement }, { data: intakeTokens }] = await Promise.all([
    q,
    supabase.from("channels").select("id, platform, display_name, username").eq("workspace_id", workspace.id),
    supabase.from("editorial_drafts").select("campaign_id").eq("workspace_id", workspace.id).not("campaign_id", "is", null).limit(5000),
    supabase.rpc("campaign_engagement", { p_workspace: workspace.id }),
    isOwner
      ? supabase.from("lead_intake_tokens").select("id, name, default_campaign_id, created_at, last_used_at, revoked_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as { id: string; name: string; default_campaign_id: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null }[] }),
  ]);
  const engagementBy = new Map(((engagement ?? []) as CampaignEngagementRow[]).map((r) => [r.campaign_id, r]));
  const campaigns = (data ?? []) as CampaignRow[];
  const counts = new Map<string, number>();
  for (const d of drafts ?? []) if (d.campaign_id) counts.set(d.campaign_id, (counts.get(d.campaign_id) ?? 0) + 1);
  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Campaigns</h1>
        <p className="text-sm text-muted-foreground">Durable plans that tie together audience, channels, content, schedule and results.</p>
      </header>
      <nav aria-label="Filter campaigns" className="flex flex-wrap gap-2 text-sm">
        <Link href="/dashboard/campaigns" className={`rounded border px-2 py-1 ${!status ? "border-primary" : "border-border"}`}>Current</Link>
        {FILTERS.map((s) => (
          <Link key={s} href={`/dashboard/campaigns?status=${s}`} className={`rounded border px-2 py-1 capitalize ${status === s ? "border-primary" : "border-border"}`}>{s}</Link>
        ))}
      </nav>
      {error && <p role="alert" className="text-sm text-destructive">Campaigns are unavailable. Confirm migration 00033 is applied.</p>}
      {campaigns.length === 0 && !error ? (
        <p className="text-sm text-muted-foreground">No campaigns here yet.</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {campaigns.map((c) => (
            <li key={c.id} className="rounded-lg border border-border p-4">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/dashboard/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                <span className={`rounded px-2 py-0.5 text-xs capitalize ${CAMPAIGN_STATUS_TONE[c.status] ?? ""}`}>{c.status}</span>
              </div>
              <p className="mt-1 text-xs capitalize text-muted-foreground">{c.objective.replace("_", " ")} · {counts.get(c.id) ?? 0} content item(s) · {c.channel_ids.length} channel(s)</p>
              {engagementBy.has(c.id) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Last 30 days: {Number(engagementBy.get(c.id)!.comments)} comments · {Number(engagementBy.get(c.id)!.first_touch_contacts)} new leads
                </p>
              )}
              {(c.starts_at || c.ends_at) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {c.starts_at ? new Date(c.starts_at).toLocaleDateString() : "…"} – {c.ends_at ? new Date(c.ends_at).toLocaleDateString() : "…"}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer font-medium">New campaign</summary>
        <div className="mt-3"><CampaignForm channels={(channels ?? []).map((c) => ({ id: c.id, label: channelLabel(c) }))} /></div>
      </details>
      {isOwner && (
        <section className="space-y-3 rounded-lg border border-border p-4" aria-label="Lead intake">
          <div>
            <h2 className="font-semibold">Lead intake</h2>
            <p className="text-sm text-muted-foreground">
              Send leads from your website or form backend to <code>POST /api/intake/v1/leads</code> with{" "}
              <code>Authorization: Bearer &lt;token&gt;</code> and a JSON body{" "}
              <code>{`{"email", "name", "utm": {...}, "landingUrl"}`}</code>. Leads are matched to a campaign by <code>utm_campaign</code>{" "}
              (the campaign&apos;s UTM default, or its name as a slug), or go to the token&apos;s default campaign. Send an{" "}
              <code>Idempotency-Key</code> header to make retries safe.
            </p>
          </div>
          <CreateIntakeTokenForm campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))} />
          {(intakeTokens ?? []).length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {(intakeTokens ?? []).map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {t.name}
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      · created {new Date(t.created_at).toLocaleDateString()} · last used {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "never"}
                    </span>
                    {t.revoked_at && <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs">revoked</span>}
                  </span>
                  {!t.revoked_at && (
                    <ActionButton url={`/api/v1/lead-intake/${t.id}/revoke`} label="Revoke" variant="danger" confirm="Revoke this token? Forms using it stop sending leads." />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import type { CampaignEngagementRow } from "@/lib/types/platform";

function since30Days() {
  return new Date(Date.now() - 30 * 86_400_000).toISOString();
}

/** Campaign-level engagement and lead attribution for the last 30 days (RLS-scoped RPC). */
export async function CampaignAttribution() {
  const { supabase, workspace } = await getWorkspace();
  const [{ data, error }, { data: campaigns }] = await Promise.all([
    supabase.rpc("campaign_engagement", { p_workspace: workspace.id, p_since: since30Days() }),
    supabase.from("campaigns").select("id, name, status").eq("workspace_id", workspace.id).limit(500),
  ]);
  const names = new Map((campaigns ?? []).map((c) => [c.id, c.name]));
  const rows = ((data ?? []) as CampaignEngagementRow[]).sort((a, b) => Number(b.first_touch_contacts) - Number(a.first_touch_contacts) || Number(b.comments) - Number(a.comments));
  return (
    <section className="space-y-2" aria-label="Campaign attribution">
      <h2 className="text-lg font-semibold">Campaign attribution (last 30 days)</h2>
      {error ? (
        <p className="text-sm text-muted-foreground">Attribution unavailable. Apply migration 00036.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No campaign engagement or attributed leads in the last 30 days.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Campaign</th>
                <th className="p-2 text-right">Comments</th>
                <th className="p-2 text-right">Commenters</th>
                <th className="p-2 text-right">Attributed contacts</th>
                <th className="p-2 text-right">New leads (first touch)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.campaign_id}>
                  <td className="p-2">
                    <Link href={`/dashboard/campaigns/${r.campaign_id}`} className="hover:underline">
                      {names.get(r.campaign_id) ?? "Campaign"}
                    </Link>
                  </td>
                  <td className="p-2 text-right">{Number(r.comments)}</td>
                  <td className="p-2 text-right">{Number(r.commenters)}</td>
                  <td className="p-2 text-right">{Number(r.contacts)}</td>
                  <td className="p-2 text-right">{Number(r.first_touch_contacts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

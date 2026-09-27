import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { Activity } from "./activity";
import { ManualTouchpointForm } from "./manual-touchpoint-form";
import { normalizeUtm } from "@/lib/publishing/utm";

const SOURCE_LABEL: Record<string, string> = {
  comment: "Commented on a post",
  dm: "Direct message",
  form: "Form / website lead",
  link: "Tracked link",
  manual: "Recorded by a teammate",
  import: "Imported",
};
export async function Customer360({ contactId }: { contactId: string }) {
  const { supabase, workspace } = await getWorkspace();
  const [profile, deals, work, attribution, touchpoints, campaigns] = await Promise.all([
    supabase
      .from("customer_profiles")
      .select()
      .eq("workspace_id", workspace.id)
      .eq("contact_id", contactId)
      .maybeSingle(),
    supabase
      .from("deals")
      .select("id,name,stage")
      .eq("workspace_id", workspace.id)
      .eq("contact_id", contactId)
      .limit(50),
    supabase
      .from("work_items")
      .select("id,name,status,reference")
      .eq("workspace_id", workspace.id)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("contacts")
      .select("first_touch_source, first_touch_at, last_touch_at, first_campaign_id, last_campaign_id")
      .eq("workspace_id", workspace.id)
      .eq("id", contactId)
      .maybeSingle(),
    supabase
      .from("contact_touchpoints")
      .select("id, source, campaign_id, utm, note, occurred_at, external_ref")
      .eq("workspace_id", workspace.id)
      .eq("contact_id", contactId)
      .order("occurred_at", { ascending: false })
      .limit(20),
    supabase.from("campaigns").select("id, name, status").eq("workspace_id", workspace.id).neq("status", "archived").order("created_at", { ascending: false }).limit(200),
  ]);
  const campaignName = new Map((campaigns.data ?? []).map((c) => [c.id, c.name]));
  const a = attribution.data;
  const campaignLink = (id: string | null | undefined) =>
    id ? (
      <Link className="underline" href={`/dashboard/campaigns/${id}`}>
        {campaignName.get(id) ?? "Archived campaign"}
      </Link>
    ) : (
      <span className="text-muted-foreground">none</span>
    );
  return (
    <section className="space-y-4 p-4">
      <h2 className="font-semibold">Customer 360</h2>
      {profile.error || deals.error || work.error ? (
        <p role="alert" className="text-sm text-destructive">
          CRM/work-item data unavailable. Apply migrations 00021–00022.
        </p>
      ) : (
        <>
          <Link
            className="block text-sm underline"
            href={
              profile.data
                ? `/dashboard/crm/customer_profiles/${profile.data.id}`
                : "/dashboard/crm/customer_profiles"
            }
          >
            {profile.data
              ? `Edit profile · ${profile.data.lifecycle} · Score ${profile.data.lead_score}`
              : "Create a customer profile"}
          </Link>
          {profile.data?.company_id && (
            <Link
              className="block text-sm underline"
              href={`/dashboard/crm/companies/${profile.data.company_id}`}
            >
              Company
            </Link>
          )}
          <div className="space-y-2 rounded-lg border border-border p-3" aria-label="Attribution">
            <h3 className="text-sm font-medium">Attribution</h3>
            {attribution.error ? (
              <p className="text-xs text-muted-foreground">Attribution unavailable. Apply migration 00036.</p>
            ) : (
              <>
                <dl className="grid gap-1 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">Lead source</dt>
                    <dd>{profile.data?.source || a?.first_touch_source || <span className="text-muted-foreground">unknown</span>}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">First touch</dt>
                    <dd>{a?.first_touch_at ? new Date(a.first_touch_at).toLocaleDateString() : <span className="text-muted-foreground">none</span>}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">First campaign</dt>
                    <dd>{campaignLink(a?.first_campaign_id)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Latest campaign</dt>
                    <dd>{campaignLink(a?.last_campaign_id)}</dd>
                  </div>
                </dl>
                {(touchpoints.data ?? []).length > 0 && (
                  <ul className="divide-y divide-border text-xs">
                    {(touchpoints.data ?? []).map((t) => {
                      const utm = normalizeUtm(t.utm);
                      return (
                        <li key={t.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                          <span>
                            {SOURCE_LABEL[t.source] ?? t.source}
                            {t.campaign_id && <> · {campaignLink(t.campaign_id)}</>}
                            {utm.utm_source && <span className="text-muted-foreground"> · {utm.utm_source}</span>}
                            {t.note && <span className="text-muted-foreground"> · {t.note}</span>}
                          </span>
                          <span className="text-muted-foreground">{new Date(t.occurred_at).toLocaleString()}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <ManualTouchpointForm contactId={contactId} campaigns={(campaigns.data ?? []).map((c) => ({ id: c.id, name: c.name }))} />
              </>
            )}
          </div>
          <h3 className="text-sm font-medium">Opportunities</h3>
          {deals.data?.map((d) => (
            <Link
              className="block text-sm underline"
              key={d.id}
              href={`/dashboard/crm/deals/${d.id}`}
            >
              {d.name} · {d.stage}
            </Link>
          ))}
          <h3 className="text-sm font-medium">Work items (latest 50)</h3>
          {work.data?.map((w) => (
            <Link
              className="block text-sm underline"
              key={w.id}
              href={`/dashboard/work-items/${w.id}`}
            >
              ZF-{w.reference} · {w.name} · {w.status}
            </Link>
          ))}
        </>
      )}
      <Activity kind="contacts" id={contactId} />
    </section>
  );
}

import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { Activity } from "./activity";
export async function Customer360({ contactId }: { contactId: string }) {
  const { supabase, workspace } = await getWorkspace();
  const [profile, deals, work] = await Promise.all([
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
  ]);
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

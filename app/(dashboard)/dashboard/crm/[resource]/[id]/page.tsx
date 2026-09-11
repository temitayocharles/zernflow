import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/workspace";
import { isCrmResource } from "@/lib/crm/contracts";
import { crmForms } from "@/lib/product/forms";
import { RecordForm } from "@/components/product/record-form";
import { Activity } from "@/components/product/activity";
import { crmOptions } from "@/lib/crm/options";
export default async function Detail({
  params,
}: {
  params: Promise<{ resource: string; id: string }>;
}) {
  const { resource, id } = await params;
  if (!isCrmResource(resource)) notFound();
  const { workspace, supabase } = await getWorkspace();
  const { data, error } = await supabase
    .from(resource)
    .select()
    .eq("workspace_id", workspace.id)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("CRM record unavailable");
  if (!data) notFound();
  const options = await crmOptions(supabase, workspace.id);
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 overflow-auto p-4 md:p-8">
      <Link href={`/dashboard/crm/${resource}`} className="text-sm underline">
        Back to {crmForms[resource].title}
      </Link>
      <h1 className="text-2xl font-semibold">
        {"name" in data ? data.name : "Customer profile"}
      </h1>
      {"contact_id" in data && data.contact_id && (
        <Link
          className="block text-sm underline"
          href={`/dashboard/contacts/${data.contact_id}`}
        >
          View contact and conversations
        </Link>
      )}
      {"company_id" in data && data.company_id && (
        <Link
          className="block text-sm underline"
          href={`/dashboard/crm/companies/${data.company_id}`}
        >
          View company
        </Link>
      )}
      <RecordForm
        key={data.version}
        record={data}
        fields={crmForms[resource].fields}
        endpoint={`/api/v1/crm/${resource}`}
        redirectBase={`/dashboard/crm/${resource}`}
        options={options}
      />
      <Activity
        kind={resource === "customer_profiles" ? "contacts" : resource}
        id={
          resource === "customer_profiles" && "contact_id" in data
            ? (data.contact_id ?? id)
            : id
        }
      />
    </main>
  );
}

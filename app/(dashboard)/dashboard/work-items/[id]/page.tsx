import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/workspace";
import { RecordForm } from "@/components/product/record-form";
import { Activity } from "@/components/product/activity";
import { WorkControls } from "@/components/product/work-controls";
import { workFields } from "@/lib/product/forms";
import { crmOptions } from "@/lib/crm/options";
import { workItemSla } from "@/lib/service-desk/work-items";
export default async function Detail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, workspace } = await getWorkspace();
  const { data: item, error } = await supabase
    .from("work_items")
    .select()
    .eq("workspace_id", workspace.id)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("Work item unavailable");
  if (!item) notFound();
  const { data: queues } = await supabase
    .from("work_queues")
    .select()
    .eq("workspace_id", workspace.id);
  const options = {
    ...(await crmOptions(supabase, workspace.id)),
    queues: (queues ?? []).map((q) => ({ id: q.id, label: q.name })),
  };
  const sla = workItemSla(item, new Date().toISOString());
  return (
    <main className="mx-auto w-full max-w-4xl space-y-5 overflow-auto p-4 md:p-8">
      <Link href="/dashboard/work-items" className="text-sm underline">
        All work items
      </Link>
      <h1 className="text-2xl font-semibold">
        ZF-{item.reference} · {item.name}
      </h1>
      <div className="flex flex-wrap gap-4 text-sm">
        {item.contact_id && (
          <Link
            className="underline"
            href={`/dashboard/contacts/${item.contact_id}`}
          >
            Requester contact
          </Link>
        )}
        {item.company_id && (
          <Link
            className="underline"
            href={`/dashboard/crm/companies/${item.company_id}`}
          >
            Company
          </Link>
        )}
        {item.conversation_id && (
          <Link
            className="underline"
            href={`/dashboard/inbox?conversationId=${item.conversation_id}`}
          >
            Originating conversation
          </Link>
        )}
      </div>
      <section className="grid gap-3 sm:grid-cols-2">
        {Object.entries(sla).map(([key, result]) => (
          <div key={key} className="rounded-lg border border-border p-4">
            <h2 className="font-medium">
              {key === "firstResponse" ? "First response" : "Resolution"}:{" "}
              {result.state}
            </h2>
            <p className="text-sm text-muted-foreground">
              Deadline: {new Date(result.dueAt).toLocaleString()}
            </p>
            {result.escalationRequired && (
              <p className="text-sm text-destructive">
                SLA breached — review escalation
              </p>
            )}
          </div>
        ))}
      </section>
      <WorkControls item={item} />
      <RecordForm
        key={item.version}
        fields={workFields}
        record={item}
        options={options}
        endpoint="/api/v1/work-items"
        redirectBase="/dashboard/work-items"
      />
      <Activity kind="work_items" id={item.id} />
    </main>
  );
}

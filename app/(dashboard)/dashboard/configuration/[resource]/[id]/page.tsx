import { EditorialVariants } from "@/components/product/editorial-variants";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/workspace";
import { configurationForms } from "@/lib/product/forms";
import { RecordForm } from "@/components/product/record-form";
import {
  configResource,
  ownerConfiguration,
} from "@/lib/product/config-contracts";
export default async function Detail({
  params,
}: {
  params: Promise<{ resource: string; id: string }>;
}) {
  const { resource, id } = await params;
  if (!configResource(resource) || resource === "editorial_variants")
    notFound();
  const { supabase, workspace, role } = await getWorkspace();
  const { data, error } = await supabase
    .from(resource)
    .select()
    .eq("workspace_id", workspace.id)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("Configuration unavailable");
  if (!data) notFound();
  const form = configurationForms[resource];
  const [variants, channels] =
    resource === "editorial_drafts"
      ? await Promise.all([
          supabase
            .from("editorial_variants")
            .select()
            .eq("workspace_id", workspace.id)
            .eq("draft_id", id),
          supabase
            .from("channels")
            .select("id,display_name,platform")
            .eq("workspace_id", workspace.id),
        ])
      : [
          { data: [], error: null },
          { data: [], error: null },
        ];
  const { data: activity } = await supabase
    .from("product_activity")
    .select()
    .eq("workspace_id", workspace.id)
    .eq("entity_type", resource)
    .eq("entity_id", id)
    .order("created_at", { ascending: false })
    .limit(50);
  return (
    <main className="mx-auto w-full max-w-4xl space-y-5 overflow-auto p-6">
      <Link
        className="text-sm underline"
        href={`/dashboard/configuration/${resource}`}
      >
        Back to {form.title}
      </Link>
      <h1 className="text-2xl font-semibold">
        {"name" in data ? data.name : id}
      </h1>
      <p className="text-sm text-muted-foreground">{form.description}</p>
      {!ownerConfiguration(resource) || role === "owner" ? (
        <RecordForm
          key={data.version}
          fields={form.fields}
          record={data}
          endpoint={`/api/v1/configuration/${resource}`}
          redirectBase={`/dashboard/configuration/${resource}`}
        />
      ) : (
        <p className="text-sm">
          Only the workspace owner can edit this configuration.
        </p>
      )}
      {resource === "editorial_drafts" &&
        (variants.error || channels.error ? (
          <p role="alert">Channel variants unavailable.</p>
        ) : (
          <EditorialVariants
            draftId={id}
            variants={variants.data ?? []}
            channels={(channels.data ?? []).map((c) => ({
              id: c.id,
              label: c.display_name ?? c.platform,
            }))}
          />
        ))}
      <section className="space-y-2">
        <h2 className="font-semibold">Activity (latest 50)</h2>
        {activity?.map((a) => (
          <details key={a.id} className="text-sm">
            <summary>
              {a.action} · {a.actor_id ?? "System"} ·{" "}
              {new Date(a.created_at).toLocaleString()}
            </summary>
            <pre className="overflow-auto text-xs">
              {JSON.stringify(a.changes, null, 2)}
            </pre>
          </details>
        ))}
      </section>
    </main>
  );
}

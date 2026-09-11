import { Pagination } from "@/components/product/pagination";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/workspace";
import { configurationForms } from "@/lib/product/forms";
import { RecordForm } from "@/components/product/record-form";
import {
  configResource,
  ownerConfiguration,
} from "@/lib/product/config-contracts";
export default async function Configuration({
  params,
  searchParams,
}: {
  params: Promise<{ resource: string }>;
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { resource } = await params;
  if (!configResource(resource) || resource === "editorial_variants")
    notFound();
  const { supabase, workspace, role } = await getWorkspace();
  const form = configurationForms[resource];
  const search = await searchParams;
  const page = Math.max(
    0,
    Math.min(10000, Math.floor(Number(search.page) || 0)),
  );
  let query = supabase
    .from(resource)
    .select("*", { count: "exact" })
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false })
    .order("id")
    .range(page * 50, page * 50 + 49);
  if (search.q)
    query = query.ilike(
      "name",
      `%${search.q.slice(0, 100).replace(/[%_\\]/g, "\\$&")}%`,
    );
  const { data, error, count } = await query;
  return (
    <main className="space-y-5 overflow-auto p-6">
      <h1 className="text-2xl font-semibold">{form.title}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">
        {form.description}
      </p>
      {error ? (
        <p role="alert">Data unavailable. Apply migration 00024.</p>
      ) : (
        <>
          {(!ownerConfiguration(resource) || role === "owner") && (
            <details className="rounded-lg border border-border p-4">
              <summary>Create configuration</summary>
              <RecordForm
                fields={form.fields}
                endpoint={`/api/v1/configuration/${resource}`}
                redirectBase={`/dashboard/configuration/${resource}`}
              />
            </details>
          )}
          {resource === "knowledge_sources" && (
            <Link
              className="block text-sm underline"
              href="/dashboard/knowledge"
            >
              Test retrieval and inspect citations
            </Link>
          )}
          <form className="flex gap-2">
            <label className="sr-only" htmlFor="configuration-search">
              Search names
            </label>
            <input
              id="configuration-search"
              name="q"
              defaultValue={search.q}
              placeholder="Search names"
              className="rounded border border-border bg-background p-2"
            />
            <button className="rounded border border-border p-2 text-sm">
              Search
            </button>
          </form>
          <Pagination page={page} total={count ?? 0} search={search.q} />
          {data?.map((item) => (
            <Link
              key={item.id}
              href={`/dashboard/configuration/${resource}/${item.id}`}
              className="block rounded-lg border border-border p-4"
            >
              <p className="font-medium">{item.name}</p>
              <p className="text-xs text-muted-foreground">
                {"state" in item
                  ? `Editorial ${item.state} · Not dispatched`
                  : "enabled" in item
                    ? `Retrieval ${item.enabled ? "enabled" : "disabled"} · Indexing status externally managed`
                    : "Runtime mailbox connection not verified"}
              </p>
            </Link>
          ))}
          {!data?.length && (
            <p className="text-sm text-muted-foreground">
              No configuration yet.
            </p>
          )}
        </>
      )}
    </main>
  );
}

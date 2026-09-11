import { Pagination } from "@/components/product/pagination";
import { getWorkspace } from "@/lib/workspace";
import { RecordForm } from "@/components/product/record-form";
export default async function Canned({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const page = Math.max(
    0,
    Math.min(10000, Math.floor(Number((await searchParams).page) || 0)),
  );
  const { supabase, workspace } = await getWorkspace();
  const { data, error, count } = await supabase
    .from("canned_replies")
    .select("*", { count: "exact" })
    .eq("workspace_id", workspace.id)
    .order("name")
    .order("id")
    .range(page * 50, page * 50 + 49);
  return (
    <main className="space-y-4 overflow-auto p-6">
      <h1 className="text-2xl font-semibold">Canned replies</h1>
      <p className="text-sm text-muted-foreground">
        Workspace templates inserted into the composer for review. Nothing is
        sent automatically.
      </p>
      <RecordForm
        fields={[
          { key: "name", label: "Name", required: true },
          {
            key: "body",
            label: "Reply text",
            type: "textarea",
            required: true,
          },
        ]}
        endpoint="/api/v1/canned-replies"
        redirectBase="/dashboard/canned-replies"
      />
      <Pagination page={page} total={count ?? 0} />
      {error ? (
        <p role="alert">Templates unavailable. Apply migration 00023.</p>
      ) : (
        data?.map((t) => (
          <article key={t.id} className="rounded border border-border p-4">
            <h2 className="font-semibold">{t.name}</h2>
            <p className="whitespace-pre-wrap text-sm">{t.body}</p>
            <details>
              <summary className="mt-3 text-sm">Edit reply</summary>
              <RecordForm
                key={t.version}
                record={t}
                fields={[
                  { key: "name", label: "Name", required: true },
                  {
                    key: "body",
                    label: "Reply text",
                    type: "textarea",
                    required: true,
                  },
                ]}
                endpoint="/api/v1/canned-replies"
                redirectBase="/dashboard/canned-replies"
              />
            </details>
          </article>
        ))
      )}
    </main>
  );
}

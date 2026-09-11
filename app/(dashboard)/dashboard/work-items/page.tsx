import { BulkWorkActions } from "@/components/product/bulk-work-actions";
import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { RecordForm } from "@/components/product/record-form";
import { workFields } from "@/lib/product/forms";
import { crmOptions } from "@/lib/crm/options";
import { workItemSla, workStatuses } from "@/lib/service-desk/work-items";
export default async function WorkItems({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { supabase, workspace, user } = await getWorkspace();
  const s = await searchParams;
  const page = Math.max(0, Math.min(10000, Math.floor(Number(s.page) || 0)));
  let query = supabase
    .from("work_items")
    .select("*", { count: "exact" })
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false })
    .order("id")
    .range(page * 50, page * 50 + 49);
  if (s.q)
    query = query.ilike(
      "name",
      `%${s.q.slice(0, 100).replace(/[%_\\]/g, "\\$&")}%`,
    );
  if (s.status && workStatuses.includes(s.status))
    query = query.eq("status", s.status);
  if (s.mine === "true") query = query.eq("assignee_id", user.id);
  if (s.queue_id) query = query.eq("queue_id", s.queue_id);
  const [items, queues] = await Promise.all([
    query,
    supabase
      .from("work_queues")
      .select()
      .eq("workspace_id", workspace.id)
      .order("name"),
  ]);
  if (items.error || queues.error)
    return (
      <p role="alert" className="p-8">
        Work items unavailable. Apply migrations 00021–00022 and reload.
      </p>
    );
  const options = {
    ...(await crmOptions(supabase, workspace.id)),
    queues: (queues.data ?? []).map((q) => ({ id: q.id, label: q.name })),
  };
  const now = new Date().toISOString();
  function cards(status?: string) {
    const filtered = (items.data ?? []).filter(
      (i) => !status || i.status === status,
    );
    return filtered.length ? (
      filtered.map((item) => {
        const sla = workItemSla(item, now);
        return (
          <Link
            key={item.id}
            href={`/dashboard/work-items/${item.id}`}
            className="block rounded-lg border border-border p-4 hover:bg-muted"
          >
            <p className="text-xs text-muted-foreground">
              ZF-{item.reference} · {item.kind} · {item.priority}
            </p>
            <p className="mt-1 font-medium">{item.name}</p>
            <p className="mt-2 text-xs">
              {item.status} · Response: {sla.firstResponse.state} · Resolution:{" "}
              {sla.resolution.state}
            </p>
            {item.escalated && (
              <p className="text-xs text-destructive">Escalated</p>
            )}
          </Link>
        );
      })
    ) : (
      <p className="p-4 text-sm text-muted-foreground">
        No matching work items.
      </p>
    );
  }
  return (
    <main className="space-y-5 overflow-auto p-4 md:p-8">
      <h1 className="text-2xl font-semibold">Work items</h1>
      <p className="text-sm text-muted-foreground">
        Tickets, incidents, follow-ups and tasks share one work model. SLA
        targets use calendar time.
      </p>
      <details className="rounded-xl border border-border p-4">
        <summary>Create work item</summary>
        <RecordForm
          fields={[
            ...workFields,
            {
              key: "first_response_minutes",
              label: "First response target (minutes)",
              type: "number",
              max: 525600,
            },
            {
              key: "resolution_minutes",
              label: "Resolution target (minutes)",
              type: "number",
              max: 525600,
            },
          ]}
          endpoint="/api/v1/work-items"
          redirectBase="/dashboard/work-items"
          options={options}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Default targets: 60 minutes first response, 1440 minutes resolution.
          Targets are snapshotted at creation and cannot be silently changed.
        </p>
      </details>
      <details className="rounded-xl border border-border p-4">
        <summary>Create queue</summary>
        <RecordForm
          fields={[{ key: "name", label: "Queue name", required: true }]}
          endpoint="/api/v1/work-queues"
          redirectBase="/dashboard/work-items"
        />
      </details>
      <details className="rounded-xl border border-border p-4">
        <summary>Edit queues</summary>
        <div className="mt-3 space-y-3">
          {queues.data?.map((queue) => (
            <RecordForm
              key={`${queue.id}:${queue.version}`}
              record={queue}
              fields={[
                { key: "name", label: "Queue name", required: true },
                { key: "description", label: "Description", type: "textarea" },
              ]}
              endpoint="/api/v1/work-queues"
              redirectBase="/dashboard/work-items"
            />
          ))}
        </div>
      </details>
      <form className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          Search
          <input
            name="q"
            defaultValue={s.q}
            className="block rounded border border-border bg-background p-2"
          />
        </label>
        <label className="text-sm">
          Status
          <select
            name="status"
            defaultValue={s.status}
            className="block rounded border border-border bg-background p-2"
          >
            <option value="">All</option>
            {workStatuses.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Queue
          <select
            name="queue_id"
            defaultValue={s.queue_id}
            className="block rounded border border-border bg-background p-2"
          >
            <option value="">All</option>
            {options.queues.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <input
            name="mine"
            value="true"
            type="checkbox"
            defaultChecked={s.mine === "true"}
          />{" "}
          Assigned to me
        </label>
        <label className="text-sm">
          <input
            name="view"
            value="kanban"
            type="checkbox"
            defaultChecked={s.view === "kanban"}
          />{" "}
          Kanban
        </label>
        <button className="rounded border border-border p-2 text-sm">
          Apply filters
        </button>
      </form>
      <p className="text-xs text-muted-foreground">
        {items.count} matches · Showing page {page + 1} (50 per page, including
        Kanban).
      </p>
      <BulkWorkActions items={items.data ?? []} />
      {s.view === "kanban" ? (
        <div className="grid gap-4 lg:grid-cols-5">
          {workStatuses.map((status) => (
            <section key={status} className="space-y-3">
              <h2 className="font-medium">{status}</h2>
              {cards(status)}
            </section>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">{cards()}</div>
      )}
      <nav className="flex gap-4 text-sm">
        {page > 0 && (
          <Link
            href={`?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as Record<string, string>), page: String(page - 1) })}`}
          >
            Previous
          </Link>
        )}
        {(page + 1) * 50 < (items.count ?? 0) && (
          <Link
            href={`?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as Record<string, string>), page: String(page + 1) })}`}
          >
            Next
          </Link>
        )}
      </nav>
    </main>
  );
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { workStatuses, workPriorities } from "@/lib/service-desk/work-items";
export function BulkWorkActions({
  items,
}: {
  items: { id: string; version: number; reference: number; name: string }[];
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const router = useRouter();
  return (
    <details className="rounded-xl border border-border p-4">
      <summary>Bulk update current page</summary>
      <p className="my-3 text-xs text-muted-foreground">
        All selected updates succeed together or none are applied. Existing
        status-transition rules apply. Review selections before confirming.
      </p>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const selected = new Set(form.getAll("items"));
          const status = String(form.get("status") ?? ""),
            priority = String(form.get("priority") ?? "");
          if (!selected.size || (!status && !priority)) {
            setMessage("Select items and choose a status or priority.");
            return;
          }
          setBusy(true);
          setMessage("");
          try {
            const response = await fetch("/api/v1/work-items/bulk", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                changes: items
                  .filter((i) => selected.has(i.id))
                  .map((i) => ({
                    id: i.id,
                    version: i.version,
                    ...(status ? { status } : {}),
                    ...(priority ? { priority } : {}),
                  })),
              }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            setMessage(`${data.updated} work items updated.`);
            router.refresh();
          } catch (e) {
            setMessage(e instanceof Error ? e.message : "Bulk update failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block text-sm">
          Work items
          <select
            multiple
            name="items"
            size={Math.min(8, Math.max(2, items.length))}
            className="mt-1 w-full rounded border border-border bg-background p-2"
          >
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                ZF-{i.reference} · {i.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="text-sm">
            Status
            <select
              name="status"
              className="ml-2 rounded border border-border bg-background p-2"
            >
              <option value="">Unchanged</option>
              {workStatuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Priority
            <select
              name="priority"
              className="ml-2 rounded border border-border bg-background p-2"
            >
              <option value="">Unchanged</option>
              {workPriorities.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <button
            disabled={busy}
            className="rounded border border-border p-2 text-sm disabled:opacity-50"
          >
            {busy ? "Updating…" : "Confirm bulk update"}
          </button>
        </div>
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </form>
    </details>
  );
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { allowedTransitions } from "@/lib/service-desk/work-items";
import type { WorkItem } from "@/lib/product/types";
export function WorkControls({ item }: { item: WorkItem }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function change(input: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/v1/work-items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, version: item.version }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="font-semibold">Status: {item.status}</h2>
      <div className="flex flex-wrap gap-2">
        {allowedTransitions(item.status).map((s) => (
          <button
            key={s}
            disabled={busy}
            onClick={() => change({ status: s })}
            className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            Move to {s.replaceAll("_", " ")}
          </button>
        ))}
        {!item.first_responded_at && (
          <button
            disabled={busy}
            onClick={() => change({ record_response: true })}
            className="rounded-lg border border-border px-3 py-2 text-sm"
          >
            Record first response
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Record first response only after actually responding to the requester.
        This action does not send a message.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          change({
            escalated: true,
            escalation_reason: new FormData(e.currentTarget).get("reason"),
          });
        }}
      >
        <label className="text-sm">
          Escalation reason
          <input
            name="reason"
            required
            maxLength={2000}
            defaultValue={item.escalation_reason}
            className="ml-2 rounded border border-border bg-background p-2"
          />
        </label>
        <button
          disabled={busy}
          className="ml-2 rounded border border-border p-2 text-sm"
        >
          Escalate
        </button>
      </form>
      {item.escalated && (
        <button
          disabled={busy}
          onClick={() => change({ escalated: false })}
          className="text-sm underline"
        >
          Clear escalation
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const input = "rounded-lg border border-border bg-background px-2 py-1 text-sm";

/** Records a manual touchpoint (e.g. met at an event) as the signed-in member. */
export function ManualTouchpointForm({ contactId, campaigns }: { contactId: string; campaigns: { id: string; name: string }[] }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const formEl = event.currentTarget;
        const form = new FormData(formEl);
        const res = await fetch(`/api/v1/contacts/${contactId}/touchpoints`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId: form.get("campaignId") || null, note: form.get("note") || "" }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) return setStatus(data.error ?? "Unable to record");
        formEl.reset();
        setStatus("Recorded.");
        router.refresh();
      }}
    >
      <label className="space-y-1 text-xs">
        <span className="block text-muted-foreground">Campaign</span>
        <select name="campaignId" className={input} defaultValue="">
          <option value="">No campaign</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-xs">
        <span className="block text-muted-foreground">Note</span>
        <input name="note" maxLength={1000} placeholder="Met at the spring event" className={input} />
      </label>
      <button className="rounded-lg border border-border px-2 py-1 text-sm hover:bg-accent">Add touchpoint</button>
      <span role="status" className="text-xs text-muted-foreground">
        {status}
      </span>
    </form>
  );
}

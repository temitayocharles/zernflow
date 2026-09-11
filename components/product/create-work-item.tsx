"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function CreateWorkItem({
  conversationId,
  contactId,
}: {
  conversationId: string;
  contactId: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/work-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Conversation follow-up",
          conversation_id: conversationId,
          contact_id: contactId,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      router.push(`/dashboard/work-items/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to create work item");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button
        disabled={busy}
        onClick={create}
        className="rounded border border-border px-3 py-1 text-xs disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create work item"}
      </button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function RunTask({ kinds }: { kinds: { kind: string; title: string }[] }) {
  const [kind, setKind] = useState(kinds[0]?.kind ?? "");
  const [status, setStatus] = useState("");
  const router = useRouter();
  if (!kinds.length) return null;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setStatus("Queuing…");
        const response = await fetch("/api/v1/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return setStatus(data.error ?? "Unable to queue task");
        setStatus("Queued. It runs on the next scheduler tick.");
        router.refresh();
      }}
    >
      <label className="text-sm" htmlFor="run-task-kind">
        Run now
      </label>
      <select
        id="run-task-kind"
        className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        value={kind}
        onChange={(e) => setKind(e.target.value)}
      >
        {kinds.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.title}
          </option>
        ))}
      </select>
      <button className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground">Queue</button>
      <span role="status" className="text-xs text-muted-foreground">
        {status}
      </span>
    </form>
  );
}

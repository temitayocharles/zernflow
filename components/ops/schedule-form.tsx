"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ScheduleForm({ kinds }: { kinds: { kind: string; title: string }[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<"interval" | "cron">("interval");
  const [status, setStatus] = useState("");
  const defaultTz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  return (
    <form
      className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const payload: Record<string, unknown> = {
          name: form.get("name"),
          kind: form.get("kind"),
          timezone: form.get("timezone"),
        };
        if (mode === "cron") payload.cron = form.get("cron");
        else payload.intervalSeconds = Number(form.get("interval")) * 60;
        setStatus("Saving…");
        const response = await fetch("/api/v1/schedules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return setStatus(data.error ?? "Unable to save schedule");
        setStatus("Schedule created.");
        (event.target as HTMLFormElement).reset();
        router.refresh();
      }}
    >
      <label className="space-y-1 text-sm">
        <span>Name</span>
        <input name="name" required maxLength={200} className="w-full rounded-lg border border-border bg-background px-2 py-1.5" />
      </label>
      <label className="space-y-1 text-sm">
        <span>Job</span>
        <select name="kind" className="w-full rounded-lg border border-border bg-background px-2 py-1.5">
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.title}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="space-y-1 text-sm">
        <legend>Repeat</legend>
        <label className="mr-3">
          <input type="radio" checked={mode === "interval"} onChange={() => setMode("interval")} /> Every N minutes
        </label>
        <label>
          <input type="radio" checked={mode === "cron"} onChange={() => setMode("cron")} /> Cron
        </label>
      </fieldset>
      {mode === "interval" ? (
        <label className="space-y-1 text-sm">
          <span>Minutes between runs (min 1)</span>
          <input name="interval" type="number" min={1} defaultValue={60} required className="w-full rounded-lg border border-border bg-background px-2 py-1.5" />
        </label>
      ) : (
        <label className="space-y-1 text-sm">
          <span>Cron (minute hour day month weekday)</span>
          <input name="cron" required placeholder="0 9 * * 1-5" className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono" />
        </label>
      )}
      <label className="space-y-1 text-sm">
        <span>Time zone</span>
        <input name="timezone" defaultValue={defaultTz} required className="w-full rounded-lg border border-border bg-background px-2 py-1.5" />
      </label>
      <div className="flex items-end gap-3">
        <button className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Create schedule</button>
        <span role="status" className="text-xs text-muted-foreground">
          {status}
        </span>
      </div>
    </form>
  );
}

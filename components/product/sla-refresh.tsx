"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export function SlaRefresh() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const router = useRouter();
  return (
    <div>
      <button
        disabled={busy}
        className="rounded border border-border p-2 text-sm disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          setMessage("");
          try {
            const r = await fetch("/api/v1/notifications/refresh", {
              method: "POST",
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error);
            setMessage(
              `Reviewed ${data.scanned} assigned open work items. ${data.signals} current SLA signals (duplicates suppressed).${data.truncated ? " More than 500 assigned items: this review is incomplete." : ""}`,
            );
            router.refresh();
          } catch (e) {
            setMessage(e instanceof Error ? e.message : "SLA review failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Reviewing…" : "Review my SLA warnings & breaches"}
      </button>
      <p role="status" className="mt-2 text-xs text-muted-foreground">
        {message ||
          "Manual review of up to 500 oldest assigned open items; not a background alert scheduler."}
      </p>
    </div>
  );
}

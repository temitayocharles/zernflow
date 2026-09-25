"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Sends a JSON request, reports the outcome accessibly, and refreshes server data. */
export function ActionButton({
  url,
  method = "POST",
  body,
  label,
  confirm,
  variant = "default",
}: {
  url: string;
  method?: "POST" | "PATCH" | "DELETE";
  body?: unknown;
  label: string;
  confirm?: string;
  variant?: "default" | "primary" | "danger";
}) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const styles = {
    default: "border border-border hover:bg-accent",
    primary: "bg-primary text-primary-foreground",
    danger: "border border-destructive text-destructive hover:bg-destructive/10",
  }[variant];
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        className={`rounded-lg px-3 py-1.5 text-sm disabled:opacity-50 ${styles}`}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setStatus("");
          try {
            const response = await fetch(url, {
              method,
              headers: body === undefined ? undefined : { "Content-Type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error ?? "Request failed");
            router.refresh();
          } catch (error) {
            setStatus(error instanceof Error ? error.message : "Request failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Working…" : label}
      </button>
      <span role="status" className="text-xs text-destructive">
        {status}
      </span>
    </span>
  );
}

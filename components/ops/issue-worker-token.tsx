"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function IssueWorkerToken() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const modes = form.getAll("modes");
          setStatus("Issuing…");
          const response = await fetch("/api/v1/workers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: form.get("name"), modes: modes.length ? modes : ["browser"] }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) return setStatus(data.error ?? "Unable to issue token");
          setToken(data.token);
          setStatus("");
          router.refresh();
        }}
      >
        <label className="space-y-1 text-sm">
          <span>Worker name</span>
          <input name="name" required maxLength={100} placeholder="northflank-browser-job" className="rounded-lg border border-border bg-background px-2 py-1.5" />
        </label>
        <fieldset className="text-sm">
          <legend>Modes</legend>
          <label className="mr-3">
            <input type="checkbox" name="modes" value="browser" defaultChecked /> browser
          </label>
          <label>
            <input type="checkbox" name="modes" value="api" /> api
          </label>
        </fieldset>
        <button className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Issue token</button>
        <span role="status" className="text-xs text-destructive">
          {status}
        </span>
      </form>
      {token && (
        <div role="alert" className="space-y-1 rounded-lg border border-amber-500/50 p-3 text-sm">
          <p>
            <strong>Copy this token now.</strong> It is stored only as a hash and will not be shown again. Set it as
            <code className="mx-1">ZERNFLOW_WORKER_TOKEN</code> on the worker.
          </p>
          <code className="block break-all rounded bg-muted p-2 text-xs">{token}</code>
          <button type="button" className="text-xs underline" onClick={() => setToken(null)}>
            I stored it — hide
          </button>
        </div>
      )}
    </div>
  );
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const input = "w-full rounded-lg border border-border bg-background px-2 py-1.5";

async function send(url: string, body: BodyInit, contentType = "application/json") {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data: data as { error?: string; checkQueued?: boolean; summary?: { cookieCount: number; authCookiesPresent: boolean } } };
}

export function CreateBrowserSessionForm({ platforms, disabled }: { platforms: { platform: string; label: string }[]; disabled?: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  return (
    <form
      className="grid gap-3 rounded-xl border border-border p-4 md:grid-cols-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const formEl = event.currentTarget;
        const form = new FormData(formEl);
        const res = await send("/api/v1/browser-sessions", JSON.stringify({ platform: form.get("platform"), label: form.get("label"), accountHint: form.get("accountHint") || null }));
        if (!res.ok) return setStatus(res.data.error ?? "Unable to add session");
        formEl.reset();
        setStatus("Added. Import a session file next.");
        router.refresh();
      }}
    >
      <label className="space-y-1 text-sm">
        <span>Platform</span>
        <select name="platform" className={input}>
          {platforms.map((p) => (
            <option key={p.platform} value={p.platform}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-sm">
        <span>Label</span>
        <input name="label" required maxLength={120} placeholder="Brand account" className={input} />
      </label>
      <label className="space-y-1 text-sm">
        <span>Account (optional)</span>
        <input name="accountHint" maxLength={120} placeholder="@handle" className={input} />
      </label>
      <div className="flex items-end gap-3">
        <button disabled={disabled} className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">
          Add session
        </button>
        <span role="status" className="text-xs text-muted-foreground">
          {status}
        </span>
      </div>
    </form>
  );
}

/** The file is read in the browser and sent once; it is never shown or kept client-side. */
export function ImportStateForm({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        const formEl = event.currentTarget;
        const file = (formEl.elements.namedItem("state") as HTMLInputElement).files?.[0];
        if (!file) return setStatus("Choose the state.json file first");
        if (file.size > 256 * 1024) return setStatus("That file is too large to be a session export");
        setStatus("Encrypting…");
        const res = await send(`/api/v1/browser-sessions/${sessionId}/state`, await file.text());
        formEl.reset();
        if (!res.ok) return setStatus(res.data.error ?? "Import failed");
        setStatus(`Stored ${res.data.summary?.cookieCount ?? 0} cookies.${res.data.checkQueued ? " A check is queued." : ""}`);
        router.refresh();
      }}
    >
      <input name="state" type="file" accept="application/json,.json" className="max-w-56 text-xs" />
      <button className="rounded-lg border border-border px-2 py-1">Import</button>
      <span role="status" className="text-xs text-muted-foreground">
        {status}
      </span>
    </form>
  );
}

export function AttestForm({ sessionId, confirmed, allowExperimental }: { sessionId: string; confirmed: boolean; allowExperimental: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  return (
    <form
      className="space-y-2 rounded-lg border border-border p-3 text-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const res = await send(`/api/v1/browser-sessions/${sessionId}/attest`, JSON.stringify({ confirm: form.get("confirm") === "on", allowExperimental: form.get("experimental") === "on" }));
        setStatus(res.ok ? "Saved." : res.data.error ?? "Unable to save");
        router.refresh();
      }}
    >
      <label className="flex items-start gap-2">
        <input type="checkbox" name="confirm" defaultChecked={confirmed} className="mt-1" />
        <span>I own or am authorised to operate this account, and automated access for this purpose is permitted by me and the platform&apos;s terms as they apply to me.</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" name="experimental" defaultChecked={allowExperimental} className="mt-1" />
        <span>Allow experimental checks (adapter signals are not yet verified against the live platform; results may be wrong).</span>
      </label>
      <div className="flex items-center gap-3">
        <button className="rounded-lg border border-border px-2 py-1">Save</button>
        <span role="status" className="text-xs text-muted-foreground">
          {status}
        </span>
      </div>
    </form>
  );
}

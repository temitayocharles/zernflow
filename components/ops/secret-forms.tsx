"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const KINDS = [
  ["ai_provider_key", "AI provider key"],
  ["webhook_signing", "Webhook signing secret"],
  ["browser_credential", "Browser login credential"],
  ["provider_app_credential", "Provider app credential"],
  ["api_token", "API token"],
  ["other", "Other"],
] as const;

const input = "w-full rounded-lg border border-border bg-background px-2 py-1.5";

async function send(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, error: (data as { error?: string }).error };
}

/** Values are write-only: the field is cleared after submit and never read back from the API. */
export function CreateSecretForm({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  return (
    <form
      className="grid gap-3 rounded-xl border border-border p-4 md:grid-cols-2"
      autoComplete="off"
      onSubmit={async (event) => {
        event.preventDefault();
        const formEl = event.currentTarget;
        const form = new FormData(formEl);
        setStatus("Encrypting…");
        const expires = String(form.get("expiresAt") ?? "");
        const res = await send("/api/v1/secrets", {
          name: form.get("name"),
          kind: form.get("kind"),
          value: form.get("value"),
          provider: form.get("provider") || null,
          description: form.get("description") || "",
          binding: form.get("binding") || null,
          expiresAt: expires ? new Date(expires).toISOString() : null,
        });
        formEl.reset();
        if (!res.ok) return setStatus(res.error ?? "Unable to store secret");
        setStatus("Stored.");
        router.refresh();
      }}
    >
      <label className="space-y-1 text-sm">
        <span>Name</span>
        <input name="name" required maxLength={200} className={input} />
      </label>
      <label className="space-y-1 text-sm">
        <span>Kind</span>
        <select name="kind" className={input} defaultValue="ai_provider_key">
          {KINDS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-sm md:col-span-2">
        <span>Value (write-only; never displayed again)</span>
        <input name="value" type="password" required autoComplete="new-password" spellCheck={false} className={input} />
      </label>
      <label className="space-y-1 text-sm">
        <span>Provider (optional)</span>
        <input name="provider" maxLength={64} className={input} />
      </label>
      <label className="space-y-1 text-sm">
        <span>Binding (optional, e.g. ai.gateway_key)</span>
        <input name="binding" maxLength={100} pattern="[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*" className={input} />
      </label>
      <label className="space-y-1 text-sm">
        <span>Expires (optional)</span>
        <input name="expiresAt" type="datetime-local" className={input} />
      </label>
      <label className="space-y-1 text-sm">
        <span>Description</span>
        <input name="description" maxLength={1000} className={input} />
      </label>
      <div className="flex items-center gap-3 md:col-span-2">
        <button disabled={disabled} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
          Store secret
        </button>
        <span role="status" className="text-xs text-muted-foreground">
          {status}
        </span>
      </div>
    </form>
  );
}

export function RotateSecretForm({ secretId }: { secretId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  if (!open)
    return (
      <button type="button" className="rounded-lg border border-border px-3 py-1.5 text-xs" onClick={() => setOpen(true)}>
        Rotate
      </button>
    );
  return (
    <form
      className="flex items-center gap-2"
      autoComplete="off"
      onSubmit={async (event) => {
        event.preventDefault();
        const formEl = event.currentTarget;
        const value = new FormData(formEl).get("value");
        formEl.reset();
        const res = await send(`/api/v1/secrets/${secretId}`, { action: "rotate", value });
        if (!res.ok) return setStatus(res.error ?? "Rotation failed");
        setOpen(false);
        router.refresh();
      }}
    >
      <input name="value" type="password" required autoComplete="new-password" aria-label="New value" className="rounded-lg border border-border bg-background px-2 py-1 text-xs" />
      <button className="rounded-lg bg-primary px-3 py-1 text-xs text-primary-foreground">Save</button>
      <button type="button" className="text-xs underline" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <span role="status" className="text-xs text-destructive">
        {status}
      </span>
    </form>
  );
}

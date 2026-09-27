"use client";

import { inputClass, useJsonSubmit } from "./use-submit";

const PLATFORMS = [
  { id: "threads", label: "Threads" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube", label: "YouTube" },
];

/** Owners register a Threads/LinkedIn/TikTok/YouTube account for manual (or managed-browser) publishing. */
export function ManualChannelForm() {
  const { busy, error, submit } = useJsonSubmit();
  return (
    <section className="mx-auto max-w-5xl space-y-2 rounded-lg border border-border p-4 text-sm" aria-labelledby="manual-channel-h">
      <h2 id="manual-channel-h" className="font-semibold">Add an account for manual publishing</h2>
      <p className="text-muted-foreground">
        For platforms without a Gateway connection. ZernFlow plans and schedules posts, reminds you when they are due and records the link you confirm.
        No password or token is stored, and inbox or automation features are not available for these accounts.
      </p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await submit("/api/v1/channels/manual", "POST", { platform: f.get("platform"), handle: f.get("handle"), displayName: f.get("displayName") || undefined });
      }}>
        <label>Platform
          <select name="platform" className={inputClass} defaultValue="linkedin">
            {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="grow">Handle<input name="handle" required maxLength={101} pattern="@?[A-Za-z0-9._\-]{1,100}" placeholder="brand" className={inputClass} /></label>
        <label className="grow">Display name (optional)<input name="displayName" maxLength={200} className={inputClass} /></label>
        <button disabled={busy} className="rounded border border-border px-3 py-2 hover:bg-accent disabled:opacity-50">{busy ? "Adding…" : "Add account"}</button>
      </form>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </section>
  );
}

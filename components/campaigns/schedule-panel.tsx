"use client";
import { repeatCron } from "@/lib/publishing/repeat-cron";
import { useState } from "react";
import { inputClass, isoToLocal, localToIso, useJsonSubmit } from "./use-submit";

type ModeOption = { mode: "api" | "browser" | "manual"; available: boolean; reason?: string };
export type ScheduleVariant = { id: string; label: string; state: string; issues: string[]; modes: ModeOption[]; defaultMode: string | null };
type Result = { scheduled?: number; blocked?: { variantId: string; issues: string[] }[]; error?: string };

const MODE_LABEL = { api: "Provider API", browser: "Managed browser", manual: "Manual (you post, then confirm the link)" };

/** Choose variants, execution mode and time, then schedule through the approval-checked API. */
export function SchedulePanel({ draftId, variants, canSchedule, blockedReason, defaultAt }: {
  draftId: string; variants: ScheduleVariant[]; canSchedule: boolean; blockedReason?: string; defaultAt?: string | null;
}) {
  const { busy, error, submit } = useJsonSubmit();
  const [result, setResult] = useState<Result | null>(null);
  const eligible = variants.filter((v) => ["draft", "failed", "cancelled"].includes(v.state));
  if (!eligible.length) return <p className="text-sm text-muted-foreground">No variants are waiting to be scheduled.</p>;
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const ids = f.getAll("variant").map(String);
        const modes = Object.fromEntries(ids.map((id) => [id, String(f.get(`mode:${id}`))]));
        const allowPartial = f.get("allow_partial") === "on";
        setResult(await submit<Result>(`/api/v1/content/${draftId}/schedule`, "POST", { at: localToIso(f.get("at")), variantIds: ids, modes, allowPartial }));
      }}
    >
      <ul className="space-y-2">
        {eligible.map((v) => {
          const usable = v.modes.filter((m) => m.available);
          return (
            <li key={v.id} className="rounded border border-border p-2 text-sm">
              <label className="flex items-center gap-2 font-medium">
                <input type="checkbox" name="variant" value={v.id} defaultChecked={v.issues.length === 0 && usable.length > 0} disabled={usable.length === 0} /> {v.label}
                <span className="text-xs text-muted-foreground">({v.state})</span>
              </label>
              {v.issues.length > 0 && <ul className="ml-6 list-disc text-destructive">{v.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
              <label className="ml-6 mt-1 block">How to publish
                <select name={`mode:${v.id}`} defaultValue={v.defaultMode ?? usable[0]?.mode} className={inputClass}>
                  {v.modes.map((m) => <option key={m.mode} value={m.mode} disabled={!m.available}>{MODE_LABEL[m.mode]}{m.available ? "" : ` — ${m.reason ?? "unavailable"}`}</option>)}
                </select>
              </label>
            </li>
          );
        })}
      </ul>
      <label className="block text-sm">Publish at (your local time; empty = now)<input type="datetime-local" name="at" defaultValue={isoToLocal(defaultAt)} className={inputClass} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allow_partial" /> Schedule valid variants even if others are blocked</label>
      <button disabled={busy || !canSchedule} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy ? "Scheduling…" : "Schedule"}</button>
      {!canSchedule && blockedReason && <p className="text-sm text-muted-foreground">{blockedReason}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {result?.scheduled ? <p role="status" className="text-sm">Scheduled {result.scheduled} variant(s).</p> : null}
    </form>
  );
}

export function ConfirmPublication({ variantId }: { variantId: string }) {
  const { busy, error, submit } = useJsonSubmit();
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2 text-sm" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      await submit(`/api/v1/content/variants/${variantId}/confirm`, "POST", { externalUrl: f.get("url"), externalRef: f.get("ref") || undefined });
    }}>
      <label className="grow">Published post link<input name="url" type="url" required pattern="https://.*" placeholder="https://" className={inputClass} /></label>
      <label className="grow">Post ID (optional; lets comments count toward the campaign)<input name="ref" maxLength={300} placeholder="e.g. 17895695668004550" className={inputClass} /></label>
      <button disabled={busy} className="rounded border border-border px-2 py-2 hover:bg-accent disabled:opacity-50">{busy ? "Saving…" : "Confirm published"}</button>
      {error && <p role="alert" className="w-full text-destructive">{error}</p>}
    </form>
  );
}

/**
 * Operator reconciliation for an API/browser attempt whose outcome is unknown
 * or partial (R10). "Not published" is offered only when nothing can be live.
 */
export function ReconcilePublication({ variantId, allowNotPublished }: { variantId: string; allowNotPublished: boolean }) {
  const { busy, error, submit } = useJsonSubmit();
  return (
    <div className="mt-2 space-y-2 rounded border border-amber-500/40 p-2 text-sm">
      <p>ZernFlow cannot tell whether this post went live. Check the platform, then record what you found.</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await submit(`/api/v1/content/variants/${variantId}/reconcile`, "POST", { outcome: "published", externalUrl: f.get("url"), externalRef: f.get("ref") || undefined });
      }}>
        <label className="grow">Live post link<input name="url" type="url" required pattern="https://.*" placeholder="https://" className={inputClass} /></label>
        <label className="grow">Post ID (optional)<input name="ref" maxLength={300} className={inputClass} /></label>
        <button disabled={busy} className="rounded border border-border px-2 py-2 hover:bg-accent disabled:opacity-50">It is live</button>
      </form>
      {allowNotPublished && (
        <form onSubmit={async (e) => {
          e.preventDefault();
          if (!window.confirm("Confirm nothing is live? ZernFlow will resubmit this post.")) return;
          await submit(`/api/v1/content/variants/${variantId}/reconcile`, "POST", { outcome: "not_published" });
        }}>
          <button disabled={busy} className="rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-50">Not published — resubmit</button>
        </form>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Owners attach a `content.recur` schedule: each occurrence creates a new draft
 * copy for review. Nothing is published automatically.
 */
export function RepeatContent({ draftId, draftName }: { draftId: string; draftName: string }) {
  const { busy, error, submit } = useJsonSubmit();
  return (
    <form className="flex flex-wrap items-end gap-2 text-sm" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const cron = repeatCron(String(f.get("frequency")), String(f.get("time")), Number(f.get("weekday")), Number(f.get("monthDay")));
      if (!cron) return;
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      await submit("/api/v1/schedules", "POST", { name: `Repeat: ${draftName}`.slice(0, 200), kind: "content.recur", input: { draftId }, cron, timezone });
    }}>
      <label>Every
        <select name="frequency" defaultValue="weekly" className={inputClass}>
          <option value="daily">day</option><option value="weekly">week</option><option value="monthly">month</option>
        </select>
      </label>
      <label>on (weekly)
        <select name="weekday" defaultValue="1" className={inputClass}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
      </label>
      <label>day of month (monthly)<input name="monthDay" type="number" min={1} max={28} defaultValue={1} className={inputClass} /></label>
      <label>at (your time)<input name="time" type="time" required defaultValue="09:00" className={inputClass} /></label>
      <button disabled={busy} className="rounded border border-border px-2 py-2 hover:bg-accent disabled:opacity-50">{busy ? "Saving…" : "Create repeat"}</button>
      {error && <p role="alert" className="w-full text-destructive">{error}</p>}
    </form>
  );
}

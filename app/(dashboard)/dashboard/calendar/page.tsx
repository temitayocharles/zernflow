import Link from "next/link";
import { Suspense } from "react";
import { getWorkspace } from "@/lib/workspace";
import { TimezoneSync } from "@/components/campaigns/timezone-sync";
import { dayKey, monthGrid, monthWindow, nowDate, parseMonth, shiftMonth, validTimeZone } from "@/lib/publishing/calendar";
import { STATE_TONE } from "@/lib/publishing/display";
import type { PublishState } from "@/lib/product/types";

type Item = {
  id: string; publish_state: PublishState; scheduled_at: string | null; published_at: string | null; draft_id: string;
  editorial_drafts: { name: string; campaign_id: string | null } | null;
  channels: { platform: string; display_name: string | null; username: string | null } | null;
};

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ month?: string; tz?: string; campaign?: string }> }) {
  const sp = await searchParams;
  const tz = validTimeZone(sp.tz);
  const zone = tz ?? "UTC";
  const { year, month } = parseMonth(sp.month, nowDate());
  const { supabase, workspace } = await getWorkspace();
  const { from, to } = monthWindow(year, month);
  const select = "id, publish_state, scheduled_at, published_at, draft_id, editorial_drafts(name, campaign_id), channels(platform, display_name, username)";
  const [scheduled, published] = await Promise.all([
    supabase.from("editorial_variants").select(select).eq("workspace_id", workspace.id).neq("publish_state", "published").gte("scheduled_at", from).lt("scheduled_at", to).limit(1000),
    supabase.from("editorial_variants").select(select).eq("workspace_id", workspace.id).eq("publish_state", "published").gte("published_at", from).lt("published_at", to).limit(1000),
  ]);
  const items = ([...(scheduled.data ?? []), ...(published.data ?? [])] as unknown as Item[]).filter((i) => !sp.campaign || i.editorial_drafts?.campaign_id === sp.campaign);
  const byDay = new Map<string, (Item & { at: string })[]>();
  for (const i of items) {
    const at = i.publish_state === "published" ? i.published_at : i.scheduled_at;
    if (!at) continue;
    const key = dayKey(at, zone);
    byDay.set(key, [...(byDay.get(key) ?? []), { ...i, at }]);
  }
  for (const list of byDay.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  const weeks = monthGrid(year, month);
  const title = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
  const time = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: zone });
  const link = (m: string) => `/dashboard/calendar?month=${m}${tz ? `&tz=${encodeURIComponent(tz)}` : ""}${sp.campaign ? `&campaign=${encodeURIComponent(sp.campaign)}` : ""}`;
  const error = scheduled.error || published.error;
  return (
    <div className="space-y-4 p-6">
      <Suspense><TimezoneSync current={tz} /></Suspense>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Calendar</h1>
          <p className="text-sm text-muted-foreground">Scheduled and published posts by day ({zone}).</p>
        </div>
        <nav aria-label="Month" className="flex items-center gap-3 text-sm">
          <Link href={link(shiftMonth(year, month, -1))} className="rounded border border-border px-2 py-1">← Previous</Link>
          <span className="font-medium">{title}</span>
          <Link href={link(shiftMonth(year, month, 1))} className="rounded border border-border px-2 py-1">Next →</Link>
        </nav>
      </header>
      {error && <p role="alert" className="text-sm text-destructive">Calendar is unavailable. Confirm migration 00033 is applied.</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px] table-fixed border-collapse text-xs">
          <thead><tr>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <th key={d} className="p-1 text-left font-medium text-muted-foreground">{d}</th>)}</tr></thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w[0].key}>
                {w.map((d) => (
                  <td key={d.key} className={`h-28 border border-border p-1 align-top ${d.inMonth ? "" : "bg-muted/40 text-muted-foreground"}`}>
                    <div className="mb-1 font-medium">{d.day}</div>
                    <ul className="space-y-1">
                      {(byDay.get(d.key) ?? []).slice(0, 4).map((i) => (
                        <li key={i.id}>
                          <Link href={`/dashboard/content/${i.draft_id}`} className={`block truncate rounded px-1 ${STATE_TONE[i.publish_state]}`} title={`${i.editorial_drafts?.name ?? "Content"} · ${i.channels?.platform ?? ""}`}>
                            {time.format(new Date(i.at))} {i.channels?.platform ?? ""} · {i.editorial_drafts?.name ?? "Content"}
                          </Link>
                        </li>
                      ))}
                      {(byDay.get(d.key)?.length ?? 0) > 4 && <li className="text-muted-foreground">+{(byDay.get(d.key)?.length ?? 0) - 4} more</li>}
                    </ul>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

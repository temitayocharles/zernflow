import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { upcomingWindow } from "@/lib/health/window";
import { STATE_LABEL, STATE_TONE } from "@/lib/publishing/display";
import type { PublishState } from "@/lib/product/types";

export const dynamic = "force-dynamic";

type Upcoming = {
  id: string; draft_id: string; scheduled_at: string; publish_state: PublishState; execution_mode: string | null;
  editorial_drafts: { name: string } | null; channels: { platform: string } | null;
};

/** Operator home: what is running, what is next, and what needs a human. */
export default async function DashboardPage() {
  const { supabase, workspace, user } = await getWorkspace();
  const { now, until } = upcomingWindow(7);
  const head = { count: "exact" as const, head: true };
  const [campaigns, scheduled, attention, failedPosts, openConversations, unread, upcoming, needsYou] = await Promise.all([
    supabase.from("campaigns").select("id", head).eq("workspace_id", workspace.id).eq("status", "active"),
    supabase.from("editorial_variants").select("id", head).eq("workspace_id", workspace.id).in("publish_state", ["scheduled", "queued"]).gte("scheduled_at", now).lt("scheduled_at", until),
    supabase.from("tasks").select("id", head).eq("workspace_id", workspace.id).or("state.eq.waiting_for_user,human_intervention.eq.requested,approval_state.eq.pending"),
    supabase.from("editorial_variants").select("id", head).eq("workspace_id", workspace.id).eq("publish_state", "failed"),
    supabase.from("conversations").select("id", head).eq("workspace_id", workspace.id).eq("status", "open"),
    supabase.from("operator_notifications").select("id", head).eq("workspace_id", workspace.id).eq("recipient_id", user.id).is("read_at", null),
    supabase.from("editorial_variants").select("id, draft_id, scheduled_at, publish_state, execution_mode, editorial_drafts(name), channels(platform)").eq("workspace_id", workspace.id).in("publish_state", ["scheduled", "queued", "publishing"]).lt("scheduled_at", until).order("scheduled_at").limit(10),
    supabase.from("tasks").select("id, objective, state, intervention_reason").eq("workspace_id", workspace.id).or("state.eq.waiting_for_user,human_intervention.eq.requested,approval_state.eq.pending").order("next_run_at").limit(8),
  ]);
  const cards: [string, number | null, string][] = [
    ["Active campaigns", campaigns.count, "/dashboard/campaigns?status=active"],
    ["Posts in the next 7 days", scheduled.count, "/dashboard/calendar"],
    ["Jobs needing you", attention.count, "/dashboard/jobs"],
    ["Failed posts", failedPosts.count, "/dashboard/content?state=failed"],
    ["Open conversations", openConversations.count, "/dashboard/inbox"],
    ["Unread notifications", unread.count, "/dashboard/notifications"],
  ];
  const items = (upcoming.data ?? []) as unknown as Upcoming[];
  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">{workspace.name}</p>
      </header>
      <section aria-label="Summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {cards.map(([label, value, href]) => (
          <Link key={label} href={href} className="rounded-lg border border-border p-3 hover:bg-accent">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-2xl font-semibold">{value ?? "—"}</p>
          </Link>
        ))}
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <div className="flex items-center justify-between"><h2 className="font-semibold">Up next</h2><Link href="/dashboard/calendar" className="text-sm underline">Calendar</Link></div>
          {items.length === 0 ? <p className="text-sm text-muted-foreground">Nothing scheduled in the next 7 days. <Link href="/dashboard/content?new=1" className="underline">Create content</Link></p> : (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {items.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 p-2">
                  <Link href={`/dashboard/content/${i.draft_id}`} className="min-w-0 truncate hover:underline">{i.editorial_drafts?.name ?? "Content"} <span className="text-xs text-muted-foreground">· {i.channels?.platform}{i.execution_mode === "manual" ? " · manual" : ""}</span></Link>
                  <span className="flex shrink-0 items-center gap-2 text-xs"><span className="text-muted-foreground">{new Date(i.scheduled_at).toLocaleString()}</span><span className={`rounded px-2 py-0.5 ${STATE_TONE[i.publish_state]}`}>{STATE_LABEL[i.publish_state]}</span></span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="space-y-2">
          <div className="flex items-center justify-between"><h2 className="font-semibold">Needs you</h2><Link href="/dashboard/jobs" className="text-sm underline">Jobs</Link></div>
          {(needsYou.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No approvals or interventions waiting.</p> : (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {(needsYou.data ?? []).map((t) => (
                <li key={t.id} className="p-2">
                  <Link href={`/dashboard/jobs/${t.id}`} className="hover:underline">{t.objective}</Link>
                  {t.intervention_reason && <p className="text-xs text-muted-foreground">{t.intervention_reason}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { describeHandlers } from "@/lib/tasks/handlers";
import { Pagination } from "@/components/product/pagination";
import { StateBadge } from "@/components/ops/state-badge";
import { RunTask } from "@/components/ops/run-task";
import type { TaskState } from "@/lib/types/platform";

const VIEWS: { id: string; label: string; states?: TaskState[] }[] = [
  { id: "attention", label: "Needs attention", states: ["waiting_for_user"] },
  { id: "approvals", label: "Approvals" },
  { id: "active", label: "Active", states: ["queued", "running", "waiting", "retrying"] },
  { id: "failed", label: "Dead letters", states: ["failed"] },
  { id: "completed", label: "Completed", states: ["completed"] },
  { id: "all", label: "All" },
];

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ view?: string; page?: string }> }) {
  const params = await searchParams;
  const view = VIEWS.find((v) => v.id === params.view) ?? VIEWS[0];
  const page = Math.max(0, Math.min(1000, Math.floor(Number(params.page) || 0)));
  const { supabase, workspace, role } = await getWorkspace();

  let query = supabase
    .from("tasks")
    .select(
      "id, kind, objective, state, execution_mode, attempts, next_run_at, approval_state, intervention_reason, error, created_at",
      { count: "exact" },
    )
    .eq("workspace_id", workspace.id);
  if (view.id === "approvals") query = query.eq("approval_state", "pending").not("state", "in", "(completed,failed,cancelled)");
  else if (view.states) query = query.in("state", view.states);
  const { data: tasks, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id")
    .range(page * 50, page * 50 + 49);

  const [{ count: attention }, { count: approvals }, { count: dead }] = await Promise.all([
    supabase.from("tasks").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id).eq("state", "waiting_for_user"),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .eq("approval_state", "pending")
      .not("state", "in", "(completed,failed,cancelled)"),
    supabase.from("tasks").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id).eq("state", "failed"),
  ]);
  const badges: Record<string, number> = { attention: attention ?? 0, approvals: approvals ?? 0, failed: dead ?? 0 };
  const runnable = describeHandlers().filter((h) => h.userRunnable);

  return (
    <main className="space-y-5 overflow-auto p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Jobs</h1>
          <p className="text-sm text-muted-foreground">
            Durable work ZernFlow runs for you: scheduled publishing, automations, checks and browser runs. Jobs
            survive restarts, retry with backoff, and stop for you when a human decision is required.
          </p>
        </div>
        <nav className="flex gap-3 text-sm">
          <Link className="underline" href="/dashboard/jobs/schedules">
            Schedules
          </Link>
          {role === "owner" && (
            <Link className="underline" href="/dashboard/jobs/workers">
              Workers
            </Link>
          )}
        </nav>
      </header>
      {role === "owner" && <RunTask kinds={runnable} />}
      <nav aria-label="Job views" className="flex flex-wrap gap-2 border-b border-border pb-2">
        {VIEWS.map((v) => (
          <Link
            key={v.id}
            href={`/dashboard/jobs?view=${v.id}`}
            aria-current={v.id === view.id ? "page" : undefined}
            className={`rounded-lg px-3 py-1.5 text-sm ${v.id === view.id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent"}`}
          >
            {v.label}
            {badges[v.id] ? <span className="ml-1 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{badges[v.id]}</span> : null}
          </Link>
        ))}
      </nav>
      {error ? (
        <p role="alert">Jobs are unavailable. Apply migration 00031 and reload.</p>
      ) : tasks?.length ? (
        <>
          <Pagination page={page} total={count ?? 0} />
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Job</th>
                <th>State</th>
                <th>Mode</th>
                <th>Attempts</th>
                <th>Next / reason</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const err = t.error as { class?: string; message?: string } | null;
                return (
                  <tr key={t.id} className="border-t border-border align-top">
                    <td className="py-2">
                      <Link className="font-medium underline" href={`/dashboard/jobs/${t.id}`}>
                        {t.objective}
                      </Link>
                      <div className="text-xs text-muted-foreground">{t.kind}</div>
                    </td>
                    <td>
                      <StateBadge state={t.state} />
                      {t.approval_state === "pending" && (
                        <div className="mt-1">
                          <StateBadge state="pending" />
                        </div>
                      )}
                    </td>
                    <td>{t.execution_mode}</td>
                    <td>{t.attempts}</td>
                    <td className="max-w-xs text-xs">
                      {t.state === "waiting_for_user"
                        ? t.intervention_reason
                        : t.state === "failed"
                          ? `${err?.class ?? "error"}: ${err?.message ?? ""}`
                          : ["queued", "retrying", "waiting"].includes(t.state)
                            ? new Date(t.next_run_at).toLocaleString()
                            : ""}
                    </td>
                    <td className="text-xs">{new Date(t.created_at).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing here right now.</p>
      )}
    </main>
  );
}

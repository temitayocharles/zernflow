import Link from "next/link";
import { getWorkspace } from "@/lib/workspace";
import { describeHandlers } from "@/lib/tasks/handlers";
import { ActionButton } from "@/components/ops/action-button";
import { ScheduleForm } from "@/components/ops/schedule-form";

export default async function SchedulesPage() {
  const { supabase, workspace, role } = await getWorkspace();
  const { data: schedules, error } = await supabase
    .from("task_schedules")
    .select("*")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });
  const kinds = describeHandlers().filter((h) => h.schedulable);
  const titles = new Map(kinds.map((k) => [k.kind, k.title]));
  return (
    <main className="space-y-5 overflow-auto p-6">
      <Link href="/dashboard/jobs" className="text-sm underline">
        ← Jobs
      </Link>
      <h1 className="text-2xl font-semibold">Schedules</h1>
      <p className="text-sm text-muted-foreground">
        Recurring work owned by ZernFlow. Each run becomes a durable job; runs missed while offline are caught up once,
        not replayed as a backlog.
      </p>
      {role === "owner" && <ScheduleForm kinds={kinds} />}
      {error ? (
        <p role="alert">Schedules unavailable. Apply migration 00031.</p>
      ) : schedules?.length ? (
        <ul className="space-y-2">
          {schedules.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
              <div>
                <p className="font-medium">
                  {s.name} {!s.enabled && <span className="text-xs text-muted-foreground">(paused)</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {titles.get(s.kind) ?? s.kind} · {s.cron ? `cron ${s.cron}` : `every ${Math.round((s.interval_seconds ?? 0) / 60)} min`} ·{" "}
                  {s.timezone} · next {new Date(s.next_run_at).toLocaleString()}
                </p>
              </div>
              {role === "owner" && (
                <div className="flex gap-2">
                  <ActionButton url={`/api/v1/schedules/${s.id}`} method="PATCH" body={{ enabled: !s.enabled }} label={s.enabled ? "Pause" : "Resume"} />
                  <ActionButton url={`/api/v1/schedules/${s.id}`} method="DELETE" label="Delete" variant="danger" confirm="Delete this schedule?" />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No schedules yet.</p>
      )}
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/workspace";
import { ActionButton } from "@/components/ops/action-button";
import { StateBadge } from "@/components/ops/state-badge";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function JobDetail({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  if (!UUID.test(taskId)) notFound();
  const { supabase, workspace, role } = await getWorkspace();
  const { data: task } = await supabase.from("tasks").select("*").eq("id", taskId).eq("workspace_id", workspace.id).maybeSingle();
  if (!task) notFound();
  const [{ data: events }, { data: executions }, { data: artifacts }] = await Promise.all([
    supabase.from("task_events").select("*").eq("task_id", taskId).eq("workspace_id", workspace.id).order("created_at").limit(500),
    supabase
      .from("execution_records")
      .select("*")
      .eq("task_id", taskId)
      .eq("workspace_id", workspace.id)
      .order("started_at", { ascending: false })
      .limit(100),
    supabase
      .from("artifacts")
      .select("id, kind, file_name, status, size_bytes, created_at")
      .eq("task_id", taskId)
      .eq("workspace_id", workspace.id)
      .neq("status", "deleted")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  const err = task.error as { class?: string; message?: string } | null;
  const terminal = ["completed", "failed", "cancelled"].includes(task.state);
  const action = (a: string, label: string, variant: "default" | "primary" | "danger" = "default", confirm?: string) => (
    <ActionButton url={`/api/v1/tasks/${task.id}/actions`} body={{ action: a }} label={label} variant={variant} confirm={confirm} />
  );

  return (
    <main className="space-y-6 overflow-auto p-6">
      <Link href="/dashboard/jobs" className="text-sm underline">
        ← Jobs
      </Link>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{task.objective}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StateBadge state={task.state} />
          {task.approval_state !== "not_required" && <StateBadge state={task.approval_state} />}
          <span className="text-muted-foreground">
            {task.kind} · {task.execution_mode} · attempt {task.attempts}
          </span>
        </div>
      </header>
      <section className="flex flex-wrap gap-2" aria-label="Job actions">
        {task.approval_state === "pending" && !terminal && role === "owner" && (
          <>
            {action("approve", "Approve", "primary")}
            {action("reject", "Reject", "danger", "Reject and cancel this job?")}
          </>
        )}
        {task.state === "waiting_for_user" && action("retry", "Mark resolved and resume", "primary")}
        {task.state === "failed" && role === "owner" && action("retry", "Retry", "primary", "Retry this job? External actions reuse the same idempotency key.")}
        {!terminal && action("cancel", "Cancel", "danger", "Cancel this job?")}
      </section>
      {task.state === "waiting_for_user" && (
        <p role="alert" className="rounded-xl border border-purple-500/40 p-4 text-sm">
          <strong>Needs you:</strong> {task.intervention_reason ?? "Operator action required."} ZernFlow never bypasses
          logins, MFA or platform challenges; complete the step, then resume.
        </p>
      )}
      {err && (
        <p className="rounded-xl border border-destructive/40 p-4 text-sm">
          <strong>{err.class}</strong>: {err.message}
        </p>
      )}
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        {[
          ["Created", new Date(task.created_at).toLocaleString()],
          ["Next run", new Date(task.next_run_at).toLocaleString()],
          ["Finished", task.finished_at ? new Date(task.finished_at).toLocaleString() : "—"],
          ["Correlation ID", task.correlation_id],
          ["Idempotency key", task.idempotency_key],
          ["Subject", task.subject_type ? `${task.subject_type} ${task.subject_id}` : "—"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border p-3">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Execution attempts</h2>
        {executions?.length ? (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Operation</th>
                <th>Status</th>
                <th>Attempt</th>
                <th>Latency</th>
                <th>Error</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {executions.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="py-2">
                    {e.provider} · {e.operation}
                    {e.account_ref && <div className="text-xs text-muted-foreground">{e.account_ref}</div>}
                  </td>
                  <td>
                    <StateBadge state={e.status} />
                  </td>
                  <td>{e.attempt}</td>
                  <td>{e.latency_ms !== null ? `${e.latency_ms} ms` : "—"}</td>
                  <td className="text-xs">{e.error_class ? `${e.error_class}: ${e.error_message ?? ""}` : "—"}</td>
                  <td>{e.retry_decision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">No external attempts recorded.</p>
        )}
      </section>
      {(artifacts ?? []).length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Artifacts</h2>
          <ul className="flex flex-wrap gap-2 text-sm">
            {(artifacts ?? []).map((a) => (
              <li key={a.id} className="rounded-lg border border-border px-3 py-2">
                {a.status === "available" ? (
                  <a className="underline" href={`/api/v1/assets/${a.id}/download`}>
                    {a.kind}: {a.file_name || a.id.slice(0, 8)}
                  </a>
                ) : (
                  <span>
                    {a.kind}: {a.file_name || a.id.slice(0, 8)} ({a.status.replace("_", " ")})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Timeline</h2>
        <ol className="space-y-2">
          {(events ?? []).map((e) => (
            <li key={e.id} className="rounded-lg border border-border p-3 text-sm">
              <span className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()} · {e.level}</span>
              <p>{e.message}</p>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

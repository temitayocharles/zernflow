import Link from "next/link";
import { redirect } from "next/navigation";
import { getWorkspace } from "@/lib/workspace";
import { ActionButton } from "@/components/ops/action-button";
import { IssueWorkerToken } from "@/components/ops/issue-worker-token";

export default async function WorkersPage() {
  const { supabase, workspace, role } = await getWorkspace();
  if (role !== "owner") redirect("/dashboard/jobs");
  const { data: workers, error } = await supabase
    .from("worker_identities")
    .select("id, name, token_prefix, modes, max_concurrency, created_at, last_seen_at, revoked_at")
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false });
  return (
    <main className="space-y-5 overflow-auto p-6">
      <Link href="/dashboard/jobs" className="text-sm underline">
        ← Jobs
      </Link>
      <h1 className="text-2xl font-semibold">Workers</h1>
      <p className="text-sm text-muted-foreground">
        Remote executors (for example the browser executor job, or a worker on your own K3s cluster) authenticate with a
        scoped token, lease one job at a time, and never receive database or Vault credentials. When free capacity runs
        out, jobs wait — nothing scales onto a paid plan.
      </p>
      <IssueWorkerToken />
      {error ? (
        <p role="alert">Workers unavailable. Apply migration 00031.</p>
      ) : (
        <ul className="space-y-2">
          {(workers ?? []).map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
              <div>
                <p className="font-medium">
                  {w.name} <code className="text-xs text-muted-foreground">{w.token_prefix}…</code>
                </p>
                <p className="text-xs text-muted-foreground">
                  {w.modes.join(", ")} · concurrency {w.max_concurrency} · last seen{" "}
                  {w.last_seen_at ? new Date(w.last_seen_at).toLocaleString() : "never"}
                  {w.revoked_at && ` · revoked ${new Date(w.revoked_at).toLocaleString()}`}
                </p>
              </div>
              {!w.revoked_at && (
                <ActionButton url={`/api/v1/workers/${w.id}`} method="DELETE" label="Revoke" variant="danger" confirm="Revoke this worker token now?" />
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

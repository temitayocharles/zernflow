import { getWorkspace } from "@/lib/workspace";
import { collectHealth, currentTime } from "@/lib/health/collect";
import { assessHealth, overall, type HealthStatus } from "@/lib/health/assess";

export const dynamic = "force-dynamic";

const TONE: Record<HealthStatus, string> = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  fail: "bg-destructive/15 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};
const WORD: Record<HealthStatus, string> = { ok: "Healthy", warn: "Needs attention", fail: "Failing", unknown: "Unknown" };

export default async function SystemHealthPage() {
  const { supabase, workspace, role } = await getWorkspace();
  if (role !== "owner") {
    return <div className="p-6"><h1 className="text-2xl font-semibold">System health</h1><p className="mt-2 text-sm text-muted-foreground">Only workspace owners can view system health.</p></div>;
  }
  const checks = assessHealth(await collectHealth(supabase, workspace.id, currentTime()));
  const status = overall(checks);
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">System health</h1>
        <span className={`rounded px-2 py-0.5 text-sm ${TONE[status]}`}>{WORD[status]}</span>
      </header>
      <p className="text-sm text-muted-foreground">Live checks for this deployment and workspace. Configuration is reported as present or missing; values are never shown.</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {checks.map((c) => (
          <li key={c.id} className="flex flex-wrap items-start gap-3 p-4">
            <span className={`mt-0.5 w-32 shrink-0 rounded px-2 py-0.5 text-center text-xs ${TONE[c.status]}`}>{WORD[c.status]}</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{c.label}</p>
              <p className="text-sm text-muted-foreground">{c.detail}</p>
              {c.action && <p className="mt-1 text-sm">{c.action}</p>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

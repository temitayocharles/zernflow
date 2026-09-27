import { readBudget } from "@/lib/runtime/budget";
import { readWorkerJson, workerJson, workerRoute, WorkerApiError } from "@/lib/workers/api";
import type { TaskRow } from "@/lib/types/platform";

export const runtime = "nodejs";

function sanitizeCapabilities(capabilities: unknown, version: unknown): { capabilities: { adapters: string[] }; version: string | null } | null {
  if (!Array.isArray((capabilities as { adapters?: unknown })?.adapters)) return null;
  const adapters = ((capabilities as { adapters: unknown[] }).adapters)
    .filter((a): a is string => typeof a === "string" && /^[a-z][a-z0-9_]{1,40}:[a-z_]{1,40}(:[a-z]{1,20})?$/.test(a))
    .slice(0, 50);
  return { capabilities: { adapters }, version: typeof version === "string" ? version.slice(0, 64) : null };
}

/**
 * POST /api/worker/v1/claim — lease at most one task for this worker identity.
 * Returns 204 when nothing is claimable (executors exit when idle).
 */
export async function POST(request: Request) {
  return workerRoute(request, async (ctx) => {
    const body = await readWorkerJson(request);
    const budget = readBudget();
    // Executors report what they run (display only; authority stays with the control plane).
    const reported = sanitizeCapabilities(body.capabilities, body.version);
    if (reported) await ctx.supabase.from("worker_identities").update(reported).eq("id", ctx.identity.id);
    const requested = Array.isArray(body.modes) ? body.modes.filter((m): m is string => typeof m === "string") : null;
    const modes = ctx.identity.modes.filter((m) => !requested || requested.includes(m));
    if (modes.length === 0) throw new WorkerApiError(403, "Worker is not permitted to claim these modes", "mode_denied");
    const leaseSeconds =
      typeof body.leaseSeconds === "number" ? Math.min(900, Math.max(60, Math.floor(body.leaseSeconds))) : 300;

    let maxRunning = ctx.identity.max_concurrency;
    if (modes.includes("browser")) {
      if (budget.maxBrowserConcurrency === 0) return new Response(null, { status: 204 });
      // Global browser cap (MAX_BROWSER_CONCURRENCY): queues wait rather than scale.
      const { count } = await ctx.supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("state", "running")
        .eq("execution_mode", "browser");
      const globalHeadroom = budget.maxBrowserConcurrency - (count ?? 0);
      if (globalHeadroom <= 0) return new Response(null, { status: 204 });
      maxRunning = Math.min(maxRunning, budget.maxBrowserConcurrency);
    }

    const { data, error } = await ctx.supabase.rpc("claim_tasks", {
      p_worker: ctx.leaseOwner,
      p_modes: modes,
      p_limit: 1,
      p_lease_seconds: leaseSeconds,
      p_workspace_id: ctx.identity.workspace_id,
      p_max_running: maxRunning,
    });
    if (error) throw new WorkerApiError(503, "Task queue unavailable", "queue_unavailable");
    const task = ((data ?? []) as TaskRow[])[0];
    if (!task) return new Response(null, { status: 204 });
    return workerJson({
      task: {
        id: task.id,
        kind: task.kind,
        objective: task.objective,
        input: task.input,
        attempt: task.attempts,
        executionMode: task.execution_mode,
        correlationId: task.correlation_id,
        subject: task.subject_type ? { type: task.subject_type, id: task.subject_id } : null,
        leaseExpiresAt: task.lease_expires_at,
      },
    });
  });
}

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { createServiceClient } from "@/lib/supabase/server";
import { readBudget } from "@/lib/runtime/budget";
import { secretStoreConfigured } from "@/lib/secrets/kek";
import { objectStoreConfigured } from "@/lib/storage";
import { isSocialGatewayConfigured } from "@/lib/social-gateway/server";
import type { HealthInputs } from "./assess";

/**
 * Gathers health inputs for one workspace. Workspace data is read with the
 * caller's RLS client; only the storage usage sum uses the service client
 * (same as Assets). Environment is inspected for presence only.
 */
export async function collectHealth(supabase: SupabaseClient<Database>, workspaceId: string, now: number): Promise<HealthInputs> {
  const nowIso = new Date(now).toISOString();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const count = (q: PromiseLike<{ count: number | null; error: unknown }>) => Promise.resolve(q).then((r) => (r.error ? null : (r.count ?? 0)));
  const tasks = () => supabase.from("tasks").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
  const variants = () => supabase.from("editorial_variants").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
  const budget = readBudget();
  const [tick, due, oldest, running, waiting, failed, workers, gatewayTask, failedVariants, manualDue, usage] = await Promise.all([
    supabase.from("system_heartbeats").select("*").eq("component", "tick").maybeSingle(),
    count(tasks().in("state", ["queued", "retrying", "waiting"]).lte("next_run_at", nowIso)),
    supabase.from("tasks").select("next_run_at").eq("workspace_id", workspaceId).in("state", ["queued", "retrying", "waiting"]).in("execution_mode", ["internal", "api"]).lte("next_run_at", nowIso).order("next_run_at").limit(1).maybeSingle(),
    count(tasks().eq("state", "running")),
    count(tasks().eq("state", "waiting_for_user")),
    count(tasks().eq("state", "failed").gte("finished_at", dayAgo)),
    supabase.from("worker_identities").select("name, last_seen_at, revoked_at, modes").eq("workspace_id", workspaceId).limit(50),
    supabase.from("tasks").select("state, finished_at, error").eq("workspace_id", workspaceId).eq("kind", "gateway.health_check").in("state", ["completed", "failed", "waiting_for_user"]).order("finished_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    count(variants().eq("publish_state", "failed")),
    count(tasks().eq("kind", "content.publish").eq("execution_mode", "human").eq("human_intervention", "requested").eq("state", "queued")),
    createServiceClient().then((s) => s.from("artifacts").select("size_bytes").eq("workspace_id", workspaceId).in("status", ["pending_upload", "available", "quarantined"])),
  ]);
  const legacyQueue = await collectLegacyQueue(workspaceId, nowIso);
  const heartbeat = tick.data;
  const provider = (process.env.SECRET_STORE_KEK_PROVIDER ?? "").trim() || (process.env.VAULT_ADDR && process.env.VAULT_TRANSIT_KEY ? "vault-transit" : process.env.ZERNFLOW_LOCAL_KEK ? "local" : "");
  return {
    now,
    nodeEnv: process.env.NODE_ENV,
    tick: heartbeat
      ? { lastRunAt: heartbeat.last_run_at, lastOkAt: heartbeat.last_ok_at, status: heartbeat.status, failedStages: ((heartbeat.detail as { failedStages?: string[] })?.failedStages ?? []).map(String) }
      : null,
    jobs: due === null ? null : { dueQueued: due, oldestDueAt: oldest.data?.next_run_at ?? null, running: running ?? 0, waitingForUser: waiting ?? 0, failed24h: failed ?? 0 },
    workers: (workers.data ?? []).map((w) => ({ name: w.name, lastSeenAt: w.last_seen_at, revoked: Boolean(w.revoked_at), modes: w.modes ?? [] })),
    gateway: {
      configured: isSocialGatewayConfigured(),
      lastCheck: gatewayTask.data
        ? { state: gatewayTask.data.state, finishedAt: gatewayTask.data.finished_at, error: ((gatewayTask.data.error as { message?: string } | null)?.message ?? null)?.slice(0, 200) ?? null }
        : null,
    },
    secrets: { configured: secretStoreConfigured(), provider: provider === "vault-transit" || provider === "local" ? provider : null, localAllowed: process.env.ZERNFLOW_ALLOW_LOCAL_KEK === "true" },
    storage: { configured: objectStoreConfigured(), usedBytes: (usage.data ?? []).reduce((s, r) => s + Number(r.size_bytes), 0), capBytes: budget.maxWorkspaceStorageBytes },
    legacyQueue,
    publishing: failedVariants === null ? null : { failed: failedVariants, manualDue: manualDue ?? 0 },
    budget: { paidComputeAllowed: budget.paidComputeAllowed, maxBackgroundWorkers: budget.maxBackgroundWorkers, maxBrowserConcurrency: budget.maxBrowserConcurrency, browserIdleShutdown: budget.browserIdleShutdown },
  };
}

/**
 * scheduled_jobs and legacy_queue_routes are service-only. Routing targets are
 * deployment configuration (no tenant data); pending counts are filtered to
 * the caller's workspace so no other tenant's volume is disclosed.
 */
async function collectLegacyQueue(workspaceId: string, nowIso: string): Promise<HealthInputs["legacyQueue"]> {
  const service = await createServiceClient();
  const [routes, pending, oldest] = await Promise.all([
    service.from("legacy_queue_routes").select("job_type, target"),
    service.from("scheduled_jobs").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).in("status", ["pending", "processing"]),
    service.from("scheduled_jobs").select("run_at").eq("workspace_id", workspaceId).eq("status", "pending").lte("run_at", nowIso).order("run_at").limit(1).maybeSingle(),
  ]);
  if (routes.error || !routes.data) return null;
  return {
    routes: Object.fromEntries(routes.data.map((r) => [r.job_type, r.target])),
    pending: pending.error ? 0 : (pending.count ?? 0),
    oldestPendingAt: oldest.data?.run_at ?? null,
  };
}

export function currentTime(): number {
  return Date.now();
}

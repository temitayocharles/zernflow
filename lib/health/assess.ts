/**
 * Pure System health assessment. Inputs are gathered by the page (DB, env,
 * heartbeats); this module decides status and the operator action, so the
 * rules are unit-tested and never depend on secrets (only presence flags).
 */
export type HealthStatus = "ok" | "warn" | "fail" | "unknown";
export interface HealthCheck { id: string; label: string; status: HealthStatus; detail: string; action?: string }

export interface HealthInputs {
  now: number;
  nodeEnv: string | undefined;
  tick: { lastRunAt: string; lastOkAt: string | null; status: "ok" | "degraded" | "failed"; failedStages: string[] } | null;
  jobs: { dueQueued: number; oldestDueAt: string | null; running: number; waitingForUser: number; failed24h: number } | null;
  workers: { name: string; lastSeenAt: string | null; revoked: boolean; modes: string[] }[];
  gateway: { configured: boolean; lastCheck: { state: string; finishedAt: string | null; error: string | null } | null };
  secrets: { configured: boolean; provider: "vault-transit" | "local" | null; localAllowed: boolean };
  storage: { configured: boolean; usedBytes: number; capBytes: number };
  publishing: { failed: number; manualDue: number } | null;
  /** R8 legacy queue migration; optional so older callers stay valid. null = migration 00037 not applied. */
  legacyQueue?: { routes: Record<string, "scheduled_jobs" | "tasks">; pending: number; oldestPendingAt: string | null } | null;
  budget: { paidComputeAllowed: boolean; maxBackgroundWorkers: number; maxBrowserConcurrency: number; browserIdleShutdown: boolean };
}

const MIN = 60_000;
const age = (now: number, iso: string | null | undefined) => (iso ? now - new Date(iso).getTime() : Number.POSITIVE_INFINITY);
export function ago(ms: number): string {
  if (!Number.isFinite(ms)) return "never";
  if (ms < MIN) return "just now";
  if (ms < 60 * MIN) return `${Math.round(ms / MIN)} min ago`;
  if (ms < 48 * 60 * MIN) return `${Math.round(ms / (60 * MIN))} h ago`;
  return `${Math.round(ms / (24 * 60 * MIN))} days ago`;
}

export function assessHealth(i: HealthInputs): HealthCheck[] {
  const checks: HealthCheck[] = [];

  // Scheduler (Northflank Job 2 → /api/cron/tick)
  if (!i.tick) {
    checks.push({ id: "tick", label: "Scheduler tick", status: "fail", detail: "No tick has ever been recorded.", action: "Point the maintenance cron job at POST /api/cron/tick with Authorization: Bearer $CRON_SECRET every 1–5 minutes." });
  } else {
    const since = age(i.now, i.tick.lastRunAt);
    const stale = since > 15 * MIN;
    checks.push({
      id: "tick", label: "Scheduler tick",
      status: stale ? "fail" : i.tick.status === "ok" ? "ok" : "warn",
      detail: `Last run ${ago(since)}${i.tick.status !== "ok" ? `; failed stages: ${i.tick.failedStages.join(", ") || "unknown"}` : ""}.`,
      action: stale ? "The cron job has stopped. Check the maintenance job schedule and CRON_SECRET." : i.tick.status !== "ok" ? "See the application logs for tick.stage_failed." : undefined,
    });
  }

  // Durable jobs backlog
  if (i.jobs) {
    const backlog = age(i.now, i.jobs.oldestDueAt);
    const behind = Number.isFinite(backlog) && backlog > 30 * MIN;
    checks.push({
      id: "jobs", label: "Job queue",
      status: i.jobs.failed24h > 0 || i.jobs.waitingForUser > 0 || behind ? "warn" : "ok",
      detail: `${i.jobs.dueQueued} due, ${i.jobs.running} running, ${i.jobs.waitingForUser} waiting for you, ${i.jobs.failed24h} failed in 24 h${behind ? `; oldest due job waiting ${ago(backlog)}` : ""}.`,
      action: i.jobs.waitingForUser > 0 ? "Open Jobs and resolve the jobs that need action." : behind ? "The queue is behind. It drains at MAX_TASKS_PER_TICK per tick by design (no automatic scaling)." : undefined,
    });
  } else checks.push({ id: "jobs", label: "Job queue", status: "unknown", detail: "Job tables are unavailable (migration 00031 not applied?)." });

  // External workers (browser executor)
  const active = i.workers.filter((w) => !w.revoked);
  if (active.length === 0) {
    checks.push({ id: "workers", label: "External workers", status: "unknown", detail: "No worker tokens issued. Browser automation stays unavailable until a browser worker is registered." });
  } else {
    const recent = active.filter((w) => age(i.now, w.lastSeenAt) < 24 * 60 * MIN);
    checks.push({
      id: "workers", label: "External workers",
      status: recent.length ? "ok" : "warn",
      detail: active.map((w) => `${w.name} (${w.modes.join("/")}): seen ${ago(age(i.now, w.lastSeenAt))}`).join("; "),
      action: recent.length ? undefined : "Workers are ephemeral jobs; none has checked in for 24 h. Confirm the browser job schedule and ZERNFLOW_WORKER_TOKEN.",
    });
  }

  // Agent Social Gateway
  if (!i.gateway.configured) {
    checks.push({ id: "gateway", label: "Agent Social Gateway", status: "fail", detail: "Not configured; provider actions and inbound events are unavailable.", action: "Set SOCIAL_GATEWAY_BASE_URL and its credentials on the web service." });
  } else if (!i.gateway.lastCheck) {
    checks.push({ id: "gateway", label: "Agent Social Gateway", status: "unknown", detail: "Configured; no health check has run yet.", action: "Run the Gateway health check from Jobs or schedule it." });
  } else {
    const ok = i.gateway.lastCheck.state === "completed";
    checks.push({
      id: "gateway", label: "Agent Social Gateway", status: ok ? "ok" : "warn",
      detail: `Last check ${i.gateway.lastCheck.state} ${ago(age(i.now, i.gateway.lastCheck.finishedAt))}${i.gateway.lastCheck.error ? `: ${i.gateway.lastCheck.error}` : ""}.`,
    });
  }

  // Secret store
  if (!i.secrets.configured) {
    checks.push({ id: "secrets", label: "Secret store", status: "fail", detail: "No key-encryption key configured; secrets cannot be stored or resolved.", action: "Configure Vault Transit (SECRET_STORE_KEK_PROVIDER=vault-transit, VAULT_*)." });
  } else {
    const local = i.secrets.provider === "local";
    checks.push({
      id: "secrets", label: "Secret store", status: local && i.nodeEnv === "production" ? "warn" : "ok",
      detail: `Key encryption via ${i.secrets.provider === "vault-transit" ? "Vault Transit (key held outside the database)" : "local KEK"}.`,
      action: local && i.nodeEnv === "production" ? "Local KEK is allowed by ZERNFLOW_ALLOW_LOCAL_KEK; prefer Vault Transit so the root key never lives beside the app." : undefined,
    });
  }

  // Object storage
  if (!i.storage.configured) {
    checks.push({ id: "storage", label: "Artifact storage", status: "warn", detail: "Not configured; uploads, screenshots and traces are disabled.", action: "Set ARTIFACT_S3_* for a private bucket on a free S3-compatible tier or self-hosted MinIO/Garage." });
  } else {
    const pct = i.storage.capBytes > 0 ? Math.round((i.storage.usedBytes / i.storage.capBytes) * 100) : 0;
    checks.push({ id: "storage", label: "Artifact storage", status: pct >= 90 ? "warn" : "ok", detail: `${pct}% of this workspace's cap used.`, action: pct >= 90 ? "Delete unused assets or lower MAX_ARTIFACT_RETENTION_DAYS; the cap protects the free tier." : undefined });
  }

  // Publishing
  if (i.publishing) {
    checks.push({
      id: "publishing", label: "Publishing",
      status: i.publishing.failed > 0 || i.publishing.manualDue > 0 ? "warn" : "ok",
      detail: `${i.publishing.failed} failed variant(s), ${i.publishing.manualDue} manual publication(s) due.`,
      action: i.publishing.failed || i.publishing.manualDue ? "Open Content to retry, reschedule or confirm." : undefined,
    });
  }

  // Legacy scheduled_jobs → durable tasks migration (R8)
  if (i.legacyQueue === null) {
    checks.push({ id: "legacyQueue", label: "Legacy job queue", status: "unknown", detail: "Queue routing is unavailable (migration 00037 not applied?). Legacy jobs still drain." });
  } else if (i.legacyQueue) {
    const q = i.legacyQueue;
    const routes = Object.entries(q.routes).sort(([a], [b]) => a.localeCompare(b));
    const onTasks = routes.filter(([, t]) => t === "tasks").length;
    const lag = age(i.now, q.oldestPendingAt);
    const behind = Number.isFinite(lag) && lag > 30 * MIN;
    checks.push({
      id: "legacyQueue", label: "Legacy job queue",
      status: behind ? "warn" : "ok",
      detail: `${onTasks}/${routes.length} legacy producers routed to durable jobs (${routes.map(([k, t]) => `${k}→${t}`).join(", ")}); ${q.pending} legacy job(s) pending for this workspace${behind ? `, oldest due ${ago(lag)}` : ""}.`,
      action: behind ? "The legacy drain is behind. Check the tick's legacyJobs stage in the logs." : undefined,
    });
  }

  // Zero-cost guardrails
  const b = i.budget;
  const drift = b.paidComputeAllowed || b.maxBackgroundWorkers > 1 || b.maxBrowserConcurrency > 1 || !b.browserIdleShutdown;
  checks.push({
    id: "budget", label: "Zero-cost guardrails", status: drift ? "warn" : "ok",
    detail: `PAID_COMPUTE_ALLOWED=${b.paidComputeAllowed}, MAX_BACKGROUND_WORKERS=${b.maxBackgroundWorkers}, MAX_BROWSER_CONCURRENCY=${b.maxBrowserConcurrency}, BROWSER_IDLE_SHUTDOWN=${b.browserIdleShutdown}.`,
    action: drift ? "A guardrail differs from the free-tier profile. Queues should wait, not scale." : undefined,
  });
  return checks;
}

export function overall(checks: HealthCheck[]): HealthStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return checks.every((c) => c.status === "ok") ? "ok" : "unknown";
}

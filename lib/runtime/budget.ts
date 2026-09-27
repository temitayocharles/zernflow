/**
 * Zero-cost runtime safeguards (docs/architecture/TARGET_ARCHITECTURE.md §2).
 * Queues wait instead of scaling: every limit here bounds work per process or
 * per invocation and nothing ever requests more capacity.
 */
export interface RuntimeBudget {
  paidComputeAllowed: boolean;
  maxBackgroundWorkers: number;
  maxTasksPerTick: number;
  tickTimeBudgetMs: number;
  maxBrowserConcurrency: number;
  browserIdleShutdown: boolean;
  maxUploadSizeBytes: number;
  maxArtifactRetentionDays: number;
  /** Per-workspace object storage cap so free S3-compatible tiers are never exceeded implicitly. */
  maxWorkspaceStorageBytes: number;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

export function readBudget(env: Env = process.env): RuntimeBudget {
  return {
    paidComputeAllowed: bool(env, "PAID_COMPUTE_ALLOWED", false),
    maxBackgroundWorkers: int(env, "MAX_BACKGROUND_WORKERS", 1, 1, 8),
    maxTasksPerTick: int(env, "MAX_TASKS_PER_TICK", 10, 0, 100),
    tickTimeBudgetMs: int(env, "TICK_TIME_BUDGET_MS", 25_000, 1_000, 280_000),
    maxBrowserConcurrency: int(env, "MAX_BROWSER_CONCURRENCY", 1, 0, 4),
    browserIdleShutdown: bool(env, "BROWSER_IDLE_SHUTDOWN", true),
    maxUploadSizeBytes: int(
      env,
      "MAX_UPLOAD_SIZE_BYTES",
      int(env, "MAX_UPLOAD_SIZE", 104_857_600, 1, 5_368_709_120),
      1,
      5_368_709_120,
    ),
    maxArtifactRetentionDays: int(env, "MAX_ARTIFACT_RETENTION_DAYS", 30, 1, 3650),
    maxWorkspaceStorageBytes: int(env, "MAX_WORKSPACE_STORAGE_BYTES", 5_368_709_120, 1_048_576, 1_099_511_627_776),
  };
}

export class PaidComputeRefusedError extends Error {
  constructor(adapter: string) {
    super(`Adapter "${adapter}" requires paid compute and PAID_COMPUTE_ALLOWED is false`);
    this.name = "PaidComputeRefusedError";
  }
}

/** Optional adapters that would incur spend must call this before running. */
export function assertComputeAllowed(adapter: { name: string; paid: boolean }, budget = readBudget()): void {
  if (adapter.paid && !budget.paidComputeAllowed) throw new PaidComputeRefusedError(adapter.name);
}

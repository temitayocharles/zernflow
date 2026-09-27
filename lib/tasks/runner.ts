import type { Json } from "@/lib/types/database";
import type { TaskRow } from "@/lib/types/platform";
import { readBudget, type RuntimeBudget } from "@/lib/runtime/budget";
import { logger } from "@/lib/observability/log";
import { increment, observe } from "@/lib/observability/metrics";
import { classifyError, decisionFor, TaskError } from "./errors";
import { recordExecution } from "./execution";
import { computeRetryDelay, normalizeRetryPolicy } from "./retry";
import { getHandler } from "./handlers";
import type { ServiceClient, TaskContext, TaskHandler } from "./types";

export interface RunBatchResult {
  claimed: number;
  completed: number;
  deferred: number;
  retrying: number;
  waitingForUser: number;
  failed: number;
  stoppedBy: "empty" | "task_limit" | "time_budget";
}

export interface RunBatchOptions {
  supabase: ServiceClient;
  workerId: string;
  budget?: RuntimeBudget;
  resolveHandler?: (kind: string) => TaskHandler | undefined;
  now?: () => number;
}

/** Executes one claimed task and settles it through the lease-checked RPCs. */
export async function executeClaimedTask(
  supabase: ServiceClient,
  workerId: string,
  task: TaskRow,
  options: { budget: RuntimeBudget; deadline: number; resolveHandler: (kind: string) => TaskHandler | undefined },
): Promise<"completed" | "deferred" | "retrying" | "waiting_for_user" | "failed" | "lost"> {
  const started = Date.now();
  const fields = {
    correlationId: task.correlation_id,
    workspaceId: task.workspace_id,
    taskId: task.id,
    operation: task.kind,
    attempt: task.attempts,
  };
  const ctx: TaskContext = {
    task,
    supabase,
    budget: options.budget,
    deadline: options.deadline,
    async event(level, message, data = {}) {
      await supabase.rpc("task_log", {
        p_workspace: task.workspace_id,
        p_task: task.id,
        p_level: level,
        p_message: message,
        p_data: data as Json,
      });
    },
    execute: (input, fn) => recordExecution(supabase, task, input, fn),
  };

  try {
    const handler = options.resolveHandler(task.kind);
    if (!handler?.run) throw new TaskError("validation", `No in-process handler for task kind "${task.kind}"`);
    const input = handler.parseInput(task.input);
    const outcome = await handler.run(ctx, input);
    if (outcome.status === "deferred") {
      const { data } = await supabase.rpc("defer_task", {
        p_task: task.id,
        p_worker: workerId,
        p_next_run_at: outcome.nextRunAt.toISOString(),
        p_step: outcome.step ?? null,
      });
      logger.info("task.deferred", { ...fields, status: "waiting", latencyMs: Date.now() - started });
      return data ? "deferred" : "lost";
    }
    const { data } = await supabase.rpc("complete_task", {
      p_task: task.id,
      p_worker: workerId,
      p_result: outcome.result ?? null,
    });
    increment("tasks_total", { kind: task.kind, outcome: "completed" });
    observe("task_duration_ms", Date.now() - started, { kind: task.kind });
    logger.info("task.completed", { ...fields, status: "completed", latencyMs: Date.now() - started });
    return data ? "completed" : "lost";
  } catch (error) {
    const classified = classifyError(error);
    const decision = classified.terminal ? "give_up" : decisionFor(classified.class);
    const policy = normalizeRetryPolicy(task.retry_policy);
    const delay = classified.retryAfterMs ?? computeRetryDelay(task.attempts, policy);
    const { data: state } = await supabase.rpc("fail_task", {
      p_task: task.id,
      p_worker: workerId,
      p_error: { class: classified.class, message: classified.message, retryable: classified.retryable } as Json,
      p_decision: decision,
      p_next_run_at: new Date(Date.now() + delay).toISOString(),
    });
    increment("tasks_total", { kind: task.kind, outcome: state ?? "lost" });
    logger.warn("task.failed", {
      ...fields,
      status: state ?? "lost",
      errorClass: classified.class,
      retryDecision: decision,
      latencyMs: Date.now() - started,
    });
    if (state === "retrying" || state === "waiting_for_user" || state === "failed") return state;
    return "lost";
  }
}

/**
 * Light worker used by the tick: claims internal/api tasks in rounds of
 * MAX_BACKGROUND_WORKERS until MAX_TASKS_PER_TICK or TICK_TIME_BUDGET_MS is
 * reached. Browser tasks are never claimed here.
 */
export async function runTaskBatch(options: RunBatchOptions): Promise<RunBatchResult> {
  const budget = options.budget ?? readBudget();
  const now = options.now ?? Date.now;
  const resolveHandler = options.resolveHandler ?? getHandler;
  const start = now();
  const deadline = start + budget.tickTimeBudgetMs;
  const result: RunBatchResult = {
    claimed: 0,
    completed: 0,
    deferred: 0,
    retrying: 0,
    waitingForUser: 0,
    failed: 0,
    stoppedBy: "empty",
  };
  const leaseSeconds = Math.max(60, Math.ceil((budget.tickTimeBudgetMs * 2) / 1000));

  while (true) {
    if (result.claimed >= budget.maxTasksPerTick) {
      result.stoppedBy = "task_limit";
      break;
    }
    if (now() >= deadline) {
      result.stoppedBy = "time_budget";
      break;
    }
    const limit = Math.min(budget.maxBackgroundWorkers, budget.maxTasksPerTick - result.claimed);
    const { data: claimed, error } = await options.supabase.rpc("claim_tasks", {
      p_worker: options.workerId,
      p_modes: ["internal", "api"],
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error(`claim_tasks failed: ${error.code ?? "unknown"}`);
    const tasks = (claimed ?? []) as TaskRow[];
    if (tasks.length === 0) {
      result.stoppedBy = "empty";
      break;
    }
    result.claimed += tasks.length;
    const outcomes = await Promise.all(
      tasks.map((task) =>
        executeClaimedTask(options.supabase, options.workerId, task, { budget, deadline, resolveHandler }),
      ),
    );
    for (const outcome of outcomes) {
      if (outcome === "completed") result.completed += 1;
      else if (outcome === "deferred") result.deferred += 1;
      else if (outcome === "retrying") result.retrying += 1;
      else if (outcome === "waiting_for_user") result.waitingForUser += 1;
      else if (outcome === "failed") result.failed += 1;
    }
  }
  return result;
}

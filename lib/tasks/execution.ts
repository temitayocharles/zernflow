import type { Json } from "@/lib/types/database";
import type { TaskRow } from "@/lib/types/platform";
import { logger } from "@/lib/observability/log";
import { increment, observe } from "@/lib/observability/metrics";
import { classifyError, decisionFor } from "./errors";
import type { ExecutionInput, ExecutionOutput, ServiceClient } from "./types";

/** Records one external attempt. The error is rethrown for the runner to classify. */
export async function recordExecution<T extends ExecutionOutput>(
  supabase: ServiceClient,
  task: Pick<TaskRow, "id" | "workspace_id" | "correlation_id" | "attempts">,
  input: ExecutionInput,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const { data: record } = await supabase
    .from("execution_records")
    .insert({
      workspace_id: task.workspace_id,
      task_id: task.id,
      correlation_id: task.correlation_id,
      provider: input.provider,
      operation: input.operation,
      mode: input.mode,
      account_ref: input.accountRef ?? null,
      attempt: Math.max(1, task.attempts),
      status: "started",
    })
    .select("id")
    .single();
  const fields = {
    correlationId: task.correlation_id,
    workspaceId: task.workspace_id,
    taskId: task.id,
    provider: input.provider,
    operation: input.operation,
    accountRef: input.accountRef ?? undefined,
    attempt: task.attempts,
  };
  try {
    const output = await fn();
    const latencyMs = Date.now() - started;
    if (record) {
      await supabase
        .from("execution_records")
        .update({
          status: "succeeded",
          finished_at: new Date().toISOString(),
          latency_ms: latencyMs,
          result_meta: (output.resultMeta ?? {}) as Json,
          external_ref: output.externalRef ?? null,
          artifact_ids: output.artifactIds ?? [],
        })
        .eq("id", record.id);
    }
    increment("execution_total", { provider: input.provider, operation: input.operation, status: "succeeded" });
    observe("execution_latency_ms", latencyMs, { provider: input.provider, operation: input.operation });
    logger.info("execution.succeeded", { ...fields, status: "succeeded", latencyMs });
    return output;
  } catch (error) {
    const classified = classifyError(error);
    const latencyMs = Date.now() - started;
    const status = classified.class === "unknown_outcome" ? "unknown" : "failed";
    if (record) {
      await supabase
        .from("execution_records")
        .update({
          status,
          finished_at: new Date().toISOString(),
          latency_ms: latencyMs,
          error_class: classified.class,
          error_message: classified.message,
          retry_decision: decisionFor(classified.class),
        })
        .eq("id", record.id);
    }
    increment("execution_total", { provider: input.provider, operation: input.operation, status });
    logger.warn("execution.failed", {
      ...fields,
      status,
      latencyMs,
      errorClass: classified.class,
      retryDecision: decisionFor(classified.class),
    });
    throw error;
  }
}

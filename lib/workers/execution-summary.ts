import type { Json } from "@/lib/types/database";
import type { TaskRow } from "@/lib/types/platform";
import { InputError, text, uuid } from "@/lib/product/validation";
import { redact } from "@/lib/observability/log";
import type { ServiceClient } from "@/lib/tasks/types";
import type { ClassifiedError } from "@/lib/tasks/errors";
import { decisionFor } from "@/lib/tasks/errors";

export interface ExecutionSummary {
  provider: string;
  operation: string;
  accountRef: string | null;
  latencyMs: number | null;
  resultMeta: Record<string, unknown>;
  externalRef: string | null;
  artifactIds: string[];
}

export function parseExecutionSummary(value: unknown): ExecutionSummary | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new InputError("Invalid execution summary");
  const v = value as Record<string, unknown>;
  const latency = v.latencyMs;
  if (latency !== undefined && (typeof latency !== "number" || latency < 0 || latency > 86_400_000)) {
    throw new InputError("Invalid execution latency");
  }
  const artifactIds = Array.isArray(v.artifactIds) ? v.artifactIds.slice(0, 50).map((a) => uuid(a, "artifact id")) : [];
  const meta = v.resultMeta && typeof v.resultMeta === "object" && !Array.isArray(v.resultMeta) ? v.resultMeta : {};
  if (JSON.stringify(meta).length > 16_000) throw new InputError("Execution metadata too large");
  return {
    provider: text(v.provider, "provider", 64, true),
    operation: text(v.operation, "operation", 100, true),
    accountRef: v.accountRef === undefined ? null : text(v.accountRef, "account reference", 200),
    latencyMs: typeof latency === "number" ? Math.round(latency) : null,
    resultMeta: redact(meta) as Record<string, unknown>,
    externalRef: v.externalRef === undefined ? null : text(v.externalRef, "external reference", 300),
    artifactIds,
  };
}

/** Records a remote worker's attempt; artifact ids must belong to the task's workspace. */
export async function writeRemoteExecution(
  supabase: ServiceClient,
  task: Pick<TaskRow, "id" | "workspace_id" | "correlation_id" | "attempts" | "execution_mode">,
  summary: ExecutionSummary,
  outcome: { status: "succeeded" } | { status: "failed" | "unknown"; error: ClassifiedError },
): Promise<void> {
  let artifactIds = summary.artifactIds;
  if (artifactIds.length > 0) {
    const { data } = await supabase
      .from("artifacts")
      .select("id")
      .eq("workspace_id", task.workspace_id)
      .neq("status", "deleted")
      .in("id", artifactIds);
    const owned = new Set((data ?? []).map((row) => row.id));
    artifactIds = artifactIds.filter((id) => owned.has(id));
  }
  await supabase.from("execution_records").insert({
    workspace_id: task.workspace_id,
    task_id: task.id,
    correlation_id: task.correlation_id,
    provider: summary.provider,
    operation: summary.operation,
    mode: task.execution_mode === "human" ? "internal" : task.execution_mode,
    account_ref: summary.accountRef,
    attempt: Math.max(1, task.attempts),
    status: outcome.status,
    finished_at: new Date().toISOString(),
    latency_ms: summary.latencyMs,
    result_meta: summary.resultMeta as Json,
    external_ref: summary.externalRef,
    artifact_ids: artifactIds,
    ...(outcome.status === "succeeded"
      ? { retry_decision: "none" as const }
      : {
          error_class: outcome.error.class,
          error_message: outcome.error.message,
          retry_decision: decisionFor(outcome.error.class),
        }),
  });
}

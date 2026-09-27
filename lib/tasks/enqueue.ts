import type { Json } from "@/lib/types/database";
import type { ExecutionMode } from "@/lib/types/platform";
import type { RetryPolicy } from "./retry";
import type { ServiceClient } from "./types";

export interface EnqueueInput {
  workspaceId: string;
  kind: string;
  objective: string;
  idempotencyKey: string;
  input?: Record<string, Json>;
  executionMode?: ExecutionMode;
  campaignId?: string | null;
  subject?: { type: string; id: string } | null;
  dependsOn?: string[];
  runAt?: Date;
  requiresApproval?: boolean;
  retryPolicy?: Partial<RetryPolicy>;
  priority?: number;
  createdBy?: string | null;
}

/**
 * Persist intent before execution. Idempotent per (workspace, idempotencyKey):
 * a duplicate enqueue returns the existing task instead of creating another.
 * Must be called with the service-role client after authorization.
 */
export async function enqueueTask(
  supabase: ServiceClient,
  input: EnqueueInput,
): Promise<{ id: string; created: boolean }> {
  const { data, error } = await supabase
    .from("tasks")
    .upsert(
      {
        workspace_id: input.workspaceId,
        kind: input.kind,
        objective: input.objective.slice(0, 500),
        idempotency_key: input.idempotencyKey,
        input: (input.input ?? {}) as Json,
        execution_mode: input.executionMode ?? "internal",
        campaign_id: input.campaignId ?? null,
        subject_type: input.subject?.type ?? null,
        subject_id: input.subject?.id ?? null,
        depends_on: input.dependsOn ?? [],
        next_run_at: (input.runAt ?? new Date()).toISOString(),
        requires_approval: input.requiresApproval ?? false,
        approval_state: input.requiresApproval ? "pending" : "not_required",
        ...(input.retryPolicy ? { retry_policy: { maxAttempts: 5, baseDelayMs: 30_000, maxDelayMs: 3_600_000, ...input.retryPolicy } as Json } : {}),
        priority: input.priority ?? 0,
        created_by: input.createdBy ?? null,
      },
      { onConflict: "workspace_id,idempotency_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw new Error(`Failed to enqueue task: ${error.code ?? "unknown"}`);
  if (data && data.length > 0) return { id: data[0].id, created: true };
  const { data: existing, error: lookupError } = await supabase
    .from("tasks")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("idempotency_key", input.idempotencyKey)
    .single();
  if (lookupError || !existing) throw new Error("Failed to resolve existing task");
  return { id: existing.id, created: false };
}

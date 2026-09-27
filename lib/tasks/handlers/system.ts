import { InputError } from "@/lib/product/validation";
import { getSocialGatewayClient } from "@/lib/social-gateway/server";
import { TaskError } from "../errors";
import type { TaskHandler } from "../types";

function emptyInput(input: unknown): Record<string, never> {
  if (input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0) return {};
  if (input === undefined || input === null) return {};
  throw new InputError("This task kind takes no input");
}

export const noopHandler: TaskHandler<Record<string, never>> = {
  kind: "system.noop",
  title: "Heartbeat",
  description: "Verifies that the scheduler and task runner are executing work.",
  mode: "internal",
  schedulable: true,
  userRunnable: true,
  parseInput: emptyInput,
  async run() {
    return { status: "completed", result: { ok: true, at: new Date().toISOString() } };
  },
};

export const pruneHistoryHandler: TaskHandler<{ retentionDays: number }> = {
  kind: "maintenance.prune_history",
  title: "Prune execution history",
  description: "Deletes finished tasks and execution records older than the retention window.",
  mode: "internal",
  schedulable: true,
  userRunnable: true,
  parseInput(input) {
    const v = (input ?? {}) as Record<string, unknown>;
    const days = v.retentionDays === undefined ? 30 : v.retentionDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 7 || days > 3650) {
      throw new InputError("retentionDays must be an integer between 7 and 3650");
    }
    return { retentionDays: days };
  },
  async run(ctx, input) {
    const cutoff = new Date(Date.now() - input.retentionDays * 86_400_000).toISOString();
    const { count: records, error: recordError } = await ctx.supabase
      .from("execution_records")
      .delete({ count: "exact" })
      .eq("workspace_id", ctx.task.workspace_id)
      .lt("started_at", cutoff);
    if (recordError) throw new TaskError("transient", "Could not prune execution records");
    const { count: tasks, error: taskError } = await ctx.supabase
      .from("tasks")
      .delete({ count: "exact" })
      .eq("workspace_id", ctx.task.workspace_id)
      .in("state", ["completed", "cancelled"])
      .lt("finished_at", cutoff)
      .neq("id", ctx.task.id);
    if (taskError) throw new TaskError("transient", "Could not prune finished tasks");
    return { status: "completed", result: { executionRecords: records ?? 0, tasks: tasks ?? 0, cutoff } };
  },
};

export const gatewayHealthHandler: TaskHandler<Record<string, never>> = {
  kind: "gateway.health_check",
  title: "Gateway health check",
  description: "Checks Agent Social Gateway reachability and Meta onboarding readiness.",
  mode: "api",
  schedulable: true,
  userRunnable: true,
  parseInput: emptyInput,
  async run(ctx) {
    const gateway = getSocialGatewayClient();
    if (!gateway) throw new TaskError("policy_denied", "Agent Social Gateway is not configured for this deployment");
    const readiness = await ctx.execute(
      { provider: "agent-social-gateway", operation: "provider_readiness", mode: "api" },
      async () => {
        const result = await gateway.getProviderReadiness("meta");
        return {
          resultMeta: {
            provider: result.provider,
            configured: result.configured,
            platforms: result.platforms.map(String),
          },
        };
      },
    );
    return { status: "completed", result: readiness.resultMeta ?? {} };
  },
};

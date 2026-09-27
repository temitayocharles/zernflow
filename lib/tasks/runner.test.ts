import { describe, expect, it, vi } from "vitest";
import { runTaskBatch } from "./runner";
import { TaskError } from "./errors";
import type { TaskHandler } from "./types";
import type { TaskRow } from "@/lib/types/platform";
import { readBudget } from "@/lib/runtime/budget";

function task(id: string, kind: string, attempts = 1): TaskRow {
  return {
    id,
    kind,
    workspace_id: "ws",
    correlation_id: `corr-${id}`,
    attempts,
    input: {},
    retry_policy: { maxAttempts: 5 },
  } as unknown as TaskRow;
}

function fakeSupabase(queue: TaskRow[]) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "claim_tasks") return { data: queue.splice(0, args.p_limit as number), error: null };
      if (fn === "fail_task") {
        const d = args.p_decision;
        return { data: d === "retry" ? "retrying" : d === "needs_user" ? "waiting_for_user" : "failed", error: null };
      }
      return { data: true, error: null };
    }),
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "rec" }, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  };
  return { client, calls };
}

const handlers: Record<string, TaskHandler> = {
  ok: { kind: "ok", title: "", description: "", mode: "internal", schedulable: false, userRunnable: false, parseInput: () => ({}), run: async () => ({ status: "completed", result: { done: true } }) },
  flaky: { kind: "flaky", title: "", description: "", mode: "internal", schedulable: false, userRunnable: false, parseInput: () => ({}), run: async () => { throw new TaskError("transient", "timeout"); } },
  mfa: { kind: "mfa", title: "", description: "", mode: "browser", schedulable: false, userRunnable: false, parseInput: () => ({}), run: async () => { throw new TaskError("human_challenge", "MFA required"); } },
  poll: { kind: "poll", title: "", description: "", mode: "api", schedulable: false, userRunnable: false, parseInput: () => ({}), run: async () => ({ status: "deferred", nextRunAt: new Date(Date.now() + 60_000), step: "awaiting provider" }) },
};

describe("runTaskBatch", () => {
  it("settles each outcome through the lease-checked RPCs and never claims browser work", async () => {
    const { client, calls } = fakeSupabase([task("1", "ok"), task("2", "flaky"), task("3", "mfa"), task("4", "poll"), task("5", "missing")]);
    const result = await runTaskBatch({
      supabase: client as never,
      workerId: "tick:test",
      budget: readBudget({}),
      resolveHandler: (k) => handlers[k],
    });
    expect(result).toMatchObject({ claimed: 5, completed: 1, retrying: 1, waitingForUser: 1, deferred: 1, failed: 1, stoppedBy: "empty" });
    const claims = calls.filter((c) => c.fn === "claim_tasks");
    expect(claims.every((c) => JSON.stringify(c.args.p_modes) === '["internal","api"]')).toBe(true);
    expect(claims[0].args.p_limit).toBe(1); // MAX_BACKGROUND_WORKERS=1 serializes
    const fails = calls.filter((c) => c.fn === "fail_task").map((c) => c.args.p_decision);
    expect(fails).toEqual(["retry", "needs_user", "give_up"]);
  });

  it("stops at MAX_TASKS_PER_TICK and at the time budget", async () => {
    const many = Array.from({ length: 20 }, (_, i) => task(String(i), "ok"));
    const { client } = fakeSupabase(many);
    const limited = await runTaskBatch({
      supabase: client as never,
      workerId: "t",
      budget: readBudget({ MAX_TASKS_PER_TICK: "3" }),
      resolveHandler: (k) => handlers[k],
    });
    expect(limited).toMatchObject({ claimed: 3, stoppedBy: "task_limit" });
    let clock = 0;
    const timed = await runTaskBatch({
      supabase: client as never,
      workerId: "t",
      budget: readBudget({ TICK_TIME_BUDGET_MS: "1000" }),
      resolveHandler: (k) => handlers[k],
      now: () => (clock += 600),
    });
    expect(timed.stoppedBy).toBe("time_budget");
  });
  it("dead-letters a terminal TaskError even when its class would normally retry", async () => {
    const { client, calls } = fakeSupabase([task("t", "terminal")]);
    const result = await runTaskBatch({
      supabase: client as never,
      workerId: "tick:test",
      budget: readBudget({}),
      resolveHandler: (k) =>
        k === "terminal"
          ? { kind: "terminal", title: "", description: "", mode: "internal", schedulable: false, userRunnable: false, parseInput: () => ({}), run: async () => { throw new TaskError("internal", "settled", { terminal: true }); } }
          : undefined,
    });
    expect(result.failed).toBe(1);
    const fail = calls.find((c) => c.fn === "fail_task");
    expect(fail?.args.p_decision).toBe("give_up");
    expect((fail?.args.p_error as { retryable: boolean }).retryable).toBe(false);
  });
});

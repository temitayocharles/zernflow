import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateWorkerToken } from "@/lib/workers/tokens";

const state = vi.hoisted(() => ({
  identity: null as null | Record<string, unknown>,
  task: null as null | Record<string, unknown>,
  rpc: vi.fn(),
  runningBrowser: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: async () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: (_cols?: string, opts?: { head?: boolean }) => {
          if (opts?.head) return { eq: () => ({ eq: async () => ({ count: state.runningBrowser }) }) };
          return chain;
        },
        eq: self,
        in: self,
        is: self,
        update: () => ({ eq: async () => ({ error: null }) }),
        insert: async () => ({ error: null }),
        maybeSingle: async () => ({ data: table === "worker_identities" ? state.identity : state.task }),
      });
      return chain;
    },
    rpc: state.rpc,
  }),
}));

import { POST as claim } from "./claim/route";
import { POST as fail } from "./tasks/[taskId]/fail/route";

const { token, hash } = generateWorkerToken();
const taskId = "30000000-0000-4000-8000-000000000001";
const req = (body: unknown, auth = `Bearer ${token}`) =>
  new Request("https://app.example/api/worker/v1/x", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  state.runningBrowser = 0;
  state.identity = {
    id: "w1",
    workspace_id: "ws-a",
    name: "browser",
    modes: ["browser"],
    max_concurrency: 1,
    token_hash: hash,
    revoked_at: null,
  };
  state.task = {
    id: taskId,
    workspace_id: "ws-a",
    correlation_id: "c",
    attempts: 1,
    execution_mode: "browser",
    retry_policy: { maxAttempts: 5 },
  };
});

describe("worker API", () => {
  it("rejects missing, malformed and revoked tokens", async () => {
    expect((await claim(req({}, ""))).status).toBe(401);
    expect((await claim(req({}, "Bearer nope"))).status).toBe(401);
    state.identity = { ...state.identity!, revoked_at: new Date().toISOString() };
    expect((await claim(req({})))).toHaveProperty("status", 401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("claims only permitted modes, scoped to the identity workspace and concurrency cap", async () => {
    state.rpc.mockResolvedValueOnce({ data: [], error: null });
    const res = await claim(req({ modes: ["browser", "internal"] }));
    expect(res.status).toBe(204);
    expect(state.rpc).toHaveBeenCalledWith("claim_tasks", expect.objectContaining({
      p_worker: "worker:w1",
      p_modes: ["browser"],
      p_workspace_id: "ws-a",
      p_max_running: 1,
      p_limit: 1,
    }));
    expect((await claim(req({ modes: ["api"] }))).status).toBe(403);
  });

  it("waits instead of scaling when the global browser cap is reached", async () => {
    state.runningBrowser = 1;
    expect((await claim(req({}))).status).toBe(204);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("derives the retry decision from the error class (workers cannot force retries of challenges)", async () => {
    state.rpc.mockResolvedValueOnce({ data: "waiting_for_user", error: null });
    const res = await fail(req({ error: { class: "human_challenge", message: "Checkpoint shown", retryAfterMs: 1000 } }), {
      params: Promise.resolve({ taskId }),
    });
    expect(res.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("fail_task", expect.objectContaining({ p_decision: "needs_user", p_worker: "worker:w1" }));
  });

  it("refuses to settle a task whose lease it does not hold", async () => {
    state.task = null;
    const res = await fail(req({ error: { class: "transient", message: "x" } }), { params: Promise.resolve({ taskId }) });
    expect(res.status).toBe(409);
  });
});

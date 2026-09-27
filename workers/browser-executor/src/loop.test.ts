import { describe, expect, it, vi } from "vitest";
import { instagramAdapter } from "../../../lib/browser/adapters/instagram";
import { WorkerApiError, type ClaimedTask } from "./client";
import { runLoop, runOnce, safeUrl, type BrowserRuntime, type CheckOutput, type LoopDeps } from "./loop";

const task = (kind = "browser.session_check"): ClaimedTask => ({ id: "t1", kind, input: { sessionId: "s1" }, attempt: 1, executionMode: "browser", correlationId: "c1" });
const session = { session: { id: "s1", platform: "instagram", label: "B", profileKey: "p", allowedHosts: ["instagram.com"] }, storageState: { cookies: [] } };

function harness(opts: { claims?: (ClaimedTask | null)[]; output?: Partial<CheckOutput> | Error; sessionError?: Error } = {}) {
  const claims = [...(opts.claims ?? [task(), null])];
  const client = {
    claim: vi.fn(async () => claims.shift() ?? null),
    heartbeat: vi.fn(async () => undefined),
    session: vi.fn(async () => {
      if (opts.sessionError) throw opts.sessionError;
      return session;
    }),
    reportSession: vi.fn(async () => undefined),
    uploadArtifact: vi.fn(async () => "art-1"),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
  const runtime: BrowserRuntime = {
    runSessionCheck: vi.fn(async () => {
      if (opts.output instanceof Error) throw opts.output;
      return { result: { state: "healthy", reason: "ok", finalUrl: "https://www.instagram.com/?token=secret" }, screenshots: [], storageState: '{"cookies":[]}', ...opts.output } as CheckOutput;
    }),
  };
  const deps: LoopDeps = { client, runtime, adapters: [instagramAdapter], log: { info: vi.fn(), warn: vi.fn() } };
  return { client, runtime, deps };
}

describe("browser executor loop", () => {
  it("advertises only non-unsupported capabilities and completes healthy checks, rotating state", async () => {
    const { client, deps } = harness();
    expect(await runOnce(deps)).toBe("ran");
    expect(client.claim).toHaveBeenCalledWith({ modes: ["browser"], capabilities: { adapters: ["instagram:session_check:experimental"] }, version: "0.1.0" });
    expect(client.reportSession).toHaveBeenCalledWith("t1", { state: "healthy", reason: "ok", storageState: '{"cookies":[]}' });
    const [, body] = client.complete.mock.calls[0] as unknown as [string, { result: { finalUrl: string } }];
    expect(body.result.finalUrl).toBe("https://www.instagram.com/");
    expect(JSON.stringify(client.complete.mock.calls)).not.toContain("secret");
    expect(client.fail).not.toHaveBeenCalled();
  });

  it("hands human states back as waiting-for-user classes with screenshot evidence and no state rotation", async () => {
    const { client, deps } = harness({ output: { result: { state: "challenge_required", reason: "checkpoint", finalUrl: "https://www.instagram.com/challenge/" }, screenshots: [{ label: "session-challenge_required", bytes: new Uint8Array([137, 80]) }], storageState: "{}" } });
    await runOnce(deps);
    expect(client.reportSession).toHaveBeenCalledWith("t1", { state: "challenge_required", reason: "checkpoint" });
    expect(client.uploadArtifact).toHaveBeenCalledWith("t1", expect.objectContaining({ kind: "screenshot", contentType: "image/png", fileName: "session-challenge_required.png" }));
    expect(client.fail).toHaveBeenCalledWith("t1", expect.objectContaining({ error: { class: "human_challenge", message: "checkpoint" }, execution: expect.objectContaining({ artifactIds: ["art-1"] }) }));
  });

  it("refuses unknown task kinds and unusable sessions without launching a browser", async () => {
    const a = harness({ claims: [task("content.publish")] });
    await runOnce(a.deps);
    expect(a.client.fail).toHaveBeenCalledWith("t1", expect.objectContaining({ error: expect.objectContaining({ class: "unsupported_capability" }) }));
    expect(a.runtime.runSessionCheck).not.toHaveBeenCalled();
    const b = harness({ sessionError: new WorkerApiError(409, "session_unavailable", "This session is revoked") });
    await runOnce(b.deps);
    expect(b.client.fail).toHaveBeenCalledWith("t1", expect.objectContaining({ error: { class: "policy_denied", message: "Session unavailable: This session is revoked" } }));
    expect(b.runtime.runSessionCheck).not.toHaveBeenCalled();
  });

  it("classifies browser crashes as transient with query-free messages and always releases the task", async () => {
    const { client, deps } = harness({ output: new Error("net::ERR_TIMED_OUT at https://www.instagram.com/accounts?sid=abc") });
    await runOnce(deps);
    const [, body] = client.fail.mock.calls[0] as unknown as [string, { error: { class: string; message: string } }];
    expect(body.error.class).toBe("transient");
    expect(body.error.message).not.toContain("sid=abc");
    const late = harness();
    late.client.reportSession.mockRejectedValueOnce(new Error("socket hang up"));
    await runOnce(late.deps);
    expect(late.client.fail).toHaveBeenCalledWith("t1", { error: { class: "transient", message: "Executor error: socket hang up" } });
  });

  it("exits when idle or at the time budget, one task at a time", async () => {
    const idle = harness({ claims: [task(), task(), null] });
    expect(await runLoop(idle.deps, { maxMs: 60_000, idleShutdown: true, pollMs: 1 })).toEqual({ ran: 2, reason: "idle" });
    let t = 0;
    const budget = harness({ claims: [null, null, null, null] });
    budget.deps.now = () => t;
    const sleep = vi.fn(async (ms: number) => void (t += ms));
    expect(await runLoop(budget.deps, { maxMs: 100, idleShutdown: false, pollMs: 40, sleep })).toEqual({ ran: 0, reason: "time_budget" });
    expect(safeUrl("not a url")).toBe("");
  });
});

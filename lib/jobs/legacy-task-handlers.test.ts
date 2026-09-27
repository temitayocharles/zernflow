import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reply: vi.fn(),
  getOperation: vi.fn(),
  resumeSession: vi.fn(),
  processEvent: vi.fn(),
}));
vi.mock("@/lib/social-gateway/server", () => ({
  requireSocialGatewayClient: () => ({ replyToConversation: mocks.reply, getOperation: mocks.getOperation }),
}));
vi.mock("@/lib/flow-engine/engine", () => ({
  FlowLoadError: class FlowLoadError extends Error {},
  resumeSession: mocks.resumeSession,
}));
vi.mock("@/lib/social-gateway/webhook-processor", () => ({ processSocialGatewayWebhookEvent: mocks.processEvent }));

import { createMemorySupabase, type MemoryDb } from "@/lib/test/memory-supabase";
import { classifyError, TaskError } from "@/lib/tasks/errors";
import type { TaskContext } from "@/lib/tasks/types";
import type { TaskRow } from "@/lib/types/platform";
import { readBudget } from "@/lib/runtime/budget";
import {
  broadcastDeliverHandler,
  flowResumeHandler,
  formatOperationStep,
  parseOperationStep,
  settleAbandonedLegacyTasks,
  SETTLED_STEP,
} from "./legacy-task-handlers";
import { getHandler } from "@/lib/tasks/handlers";

const WS = "10000000-0000-4000-8000-000000000001";
const BC = "20000000-0000-4000-8000-000000000001";
const RCPT = "30000000-0000-4000-8000-000000000001";
const SESSION = "40000000-0000-4000-8000-000000000001";
const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function seed(): MemoryDb {
  return createMemorySupabase(
    {
      broadcasts: [{ id: BC, workspace_id: WS, status: "scheduled", message_content: { text: "Hello" } }],
      broadcast_recipients: [
        {
          id: RCPT,
          broadcast_id: BC,
          contact_id: "c1",
          channel_id: "ch1",
          status: "pending",
          broadcasts: { message_content: { text: "Hello" }, workspace_id: WS },
        },
      ],
      conversations: [{ id: "conv", workspace_id: WS, contact_id: "c1", channel_id: "ch1", late_conversation_id: "gw-conv" }],
      tasks: [],
      scheduled_jobs: [],
      flow_sessions: [],
    },
    { rpc: { increment_broadcast_sent: () => null, increment_broadcast_failed: () => null } },
  );
}

function ctxFor(db: MemoryDb, overrides: Partial<TaskRow> = {}) {
  const task = {
    id: "task-1",
    workspace_id: WS,
    kind: "broadcast.deliver",
    attempts: 1,
    current_step: null,
    retry_policy: { maxAttempts: 3, baseDelayMs: 10_000, maxDelayMs: 300_000 },
    state: "running",
    ...overrides,
  } as unknown as TaskRow;
  db.tables.tasks.push(task as unknown as Record<string, unknown>);
  const events: string[] = [];
  const ctx: TaskContext = {
    task,
    supabase: db.client as never,
    budget: readBudget({}),
    deadline: Date.now() + 10_000,
    event: async (_level, message) => {
      events.push(message);
    },
    execute: (_input, fn) => fn(),
  };
  return { ctx, events };
}

beforeEach(() => vi.clearAllMocks());

describe("legacy task registry", () => {
  it("registers all three legacy kinds as internal, non-user-runnable handlers", () => {
    for (const kind of ["flow.resume", "broadcast.deliver", "gateway.event"]) {
      const h = getHandler(kind);
      expect(h, kind).toBeDefined();
      expect(h?.mode).toBe("internal");
      expect(h?.userRunnable).toBe(false);
    }
  });

  it("round-trips Gateway operation progress through current_step", () => {
    expect(parseOperationStep(formatOperationStep(2, "op-9"))).toEqual({ checks: 2, operationId: "op-9" });
    expect(parseOperationStep(formatOperationStep(1, null))).toEqual({ checks: 1, operationId: null });
    expect(parseOperationStep("settled")).toEqual({ checks: 0, operationId: null });
  });

  it("rejects malformed input as a validation error", () => {
    expect(() => broadcastDeliverHandler.parseInput({ broadcastId: "x" })).toThrow(TaskError);
    expect(() => flowResumeHandler.parseInput({ sessionId: SESSION, workspaceId: WS })).toThrow(/nodeId/);
  });
});

describe("broadcast.deliver parity", () => {
  it("defers while the Gateway operation is pending, then settles from getOperation", async () => {
    const db = seed();
    mocks.reply.mockResolvedValue({ id: "op-1", status: "pending" });
    const { ctx } = ctxFor(db);
    const input = broadcastDeliverHandler.parseInput({ broadcastId: BC, recipientId: RCPT });
    const first = await broadcastDeliverHandler.run!(ctx, input);
    expect(first.status).toBe("deferred");
    if (first.status !== "deferred") throw new Error("unreachable");
    expect(first.step).toBe("gateway-op:1:op-1");
    expect(first.nextRunAt.getTime() - Date.now()).toBeLessThanOrEqual(5_000);
    expect(mocks.reply).toHaveBeenCalledWith("gw-conv", { text: "Hello", idempotencyKey: `zernflow:broadcast:${RCPT}` });
    expect(db.tables.broadcast_recipients[0].status).toBe("sending");
    expect(db.tables.broadcasts[0].status).toBe("sending");

    mocks.getOperation.mockResolvedValue({ id: "op-1", status: "succeeded" });
    const second = ctxFor(db, { id: "task-1b", current_step: first.step });
    await expect(broadcastDeliverHandler.run!(second.ctx, input)).resolves.toEqual({ status: "completed" });
    expect(mocks.getOperation).toHaveBeenCalledWith("op-1");
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(db.tables.broadcast_recipients[0].status).toBe("sent");
    expect(db.tables.broadcasts[0].status).toBe("completed");
  });

  it("retries ordinary failures before the last attempt without settling", async () => {
    const db = seed();
    db.tables.conversations = [];
    const { ctx } = ctxFor(db, { attempts: 1 });
    const input = broadcastDeliverHandler.parseInput({ broadcastId: BC, recipientId: RCPT });
    const error = await broadcastDeliverHandler.run!(ctx, input).catch((e) => e);
    expect(error).toBeInstanceOf(TaskError);
    expect(classifyError(error)).toMatchObject({ class: "internal", retryable: true });
    expect(classifyError(error).terminal).toBeUndefined();
    expect(db.tables.broadcast_recipients[0].status).toBe("pending");
  });

  it("settles the recipient and dead-letters on the final attempt", async () => {
    const db = seed();
    db.tables.conversations = [];
    const { ctx, events } = ctxFor(db, { attempts: 3 });
    const input = broadcastDeliverHandler.parseInput({ broadcastId: BC, recipientId: RCPT });
    const error = await broadcastDeliverHandler.run!(ctx, input).catch((e) => e);
    expect(classifyError(error)).toMatchObject({ terminal: true, retryable: false });
    expect(db.tables.broadcast_recipients[0]).toMatchObject({ status: "failed" });
    expect(db.tables.tasks[0].current_step).toBe(SETTLED_STEP);
    expect(events).toContain("Legacy work settled as failed");
  });
});

describe("flow.resume parity", () => {
  const input = () =>
    flowResumeHandler.parseInput({
      sessionId: SESSION,
      workspaceId: WS,
      nodeId: "delay-1",
      flowId: "f",
      channelId: "ch1",
      contactId: "c1",
      conversationId: "conv",
    });

  it("treats a session parked by another resume task (either queue) as healthy", async () => {
    const db = seed();
    db.tables.flow_sessions.push({
      id: SESSION,
      status: "active",
      current_node_id: "delay-2",
      waiting_for_input: false,
      waiting_until: null,
      updated_at: OLD,
      flow_id: "f",
    });
    db.tables.tasks.push({ id: "other", kind: "flow.resume", subject_id: SESSION, state: "waiting" });
    const { ctx } = ctxFor(db, { kind: "flow.resume" });
    await expect(flowResumeHandler.run!(ctx, input())).resolves.toEqual({ status: "completed" });
    expect(mocks.resumeSession).not.toHaveBeenCalled();
    expect(db.tables.flow_sessions[0].status).toBe("active");
  });

  it("sees a legacy scheduled_jobs resume as parking evidence too", async () => {
    const db = seed();
    db.tables.flow_sessions.push({
      id: SESSION,
      status: "active",
      current_node_id: "delay-2",
      waiting_for_input: false,
      waiting_until: null,
      updated_at: OLD,
      flow_id: "f",
    });
    db.tables.scheduled_jobs.push({ id: "j", type: "resume_flow", status: "pending", payload: { sessionId: SESSION } });
    const { ctx } = ctxFor(db, { kind: "flow.resume" });
    await expect(flowResumeHandler.run!(ctx, input())).resolves.toEqual({ status: "completed" });
  });

  it("defers (without failing) when a stranded-looking session was written recently", async () => {
    const db = seed();
    db.tables.flow_sessions.push({
      id: SESSION,
      status: "active",
      current_node_id: "delay-2",
      waiting_for_input: false,
      waiting_until: null,
      updated_at: new Date().toISOString(),
      flow_id: "f",
    });
    const { ctx } = ctxFor(db, { kind: "flow.resume" });
    const outcome = await flowResumeHandler.run!(ctx, input());
    expect(outcome.status).toBe("deferred");
  });

  it("cancels a session stranded by a dead resume and dead-letters immediately", async () => {
    const db = seed();
    db.tables.flow_sessions.push({
      id: SESSION,
      status: "active",
      current_node_id: "delay-2",
      waiting_for_input: false,
      waiting_until: null,
      updated_at: OLD,
      flow_id: "f",
    });
    const { ctx } = ctxFor(db, { kind: "flow.resume", attempts: 1 });
    const error = await flowResumeHandler.run!(ctx, input()).catch((e) => e);
    expect(classifyError(error).terminal).toBe(true);
    expect(db.tables.flow_sessions[0].status).toBe("cancelled");
  });

  it("resumes an active session still on its delay node", async () => {
    const db = seed();
    db.tables.flow_sessions.push({ id: SESSION, status: "active", current_node_id: "delay-1", flow_id: "f", updated_at: OLD });
    const { ctx } = ctxFor(db, { kind: "flow.resume" });
    await expect(flowResumeHandler.run!(ctx, input())).resolves.toEqual({ status: "completed" });
    expect(mocks.resumeSession).toHaveBeenCalledTimes(1);
  });
});

describe("settleAbandonedLegacyTasks", () => {
  it("settles dead-lettered legacy tasks that skipped the handler's final path, once", async () => {
    const db = seed();
    db.tables.tasks.push({
      id: "dead",
      kind: "broadcast.deliver",
      state: "failed",
      finished_at: new Date().toISOString(),
      current_step: null,
      input: { broadcastId: BC, recipientId: RCPT },
      error: { message: "Worker lease expired before the task finished" },
    });
    await expect(settleAbandonedLegacyTasks(db.client as never)).resolves.toEqual({ status: "completed", settled: 1 });
    expect(db.tables.broadcast_recipients[0]).toMatchObject({
      status: "failed",
      error_message: "Worker lease expired before the task finished",
    });
    expect(db.tables.tasks.find((t) => t.id === "dead")?.current_step).toBe(SETTLED_STEP);
    await expect(settleAbandonedLegacyTasks(db.client as never)).resolves.toEqual({ status: "completed", settled: 0 });
  });
});

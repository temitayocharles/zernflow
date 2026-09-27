import { describe, expect, it } from "vitest";
import { createMemorySupabase } from "@/lib/test/memory-supabase";
import { readBudget } from "@/lib/runtime/budget";
import { TaskError } from "@/lib/tasks/errors";
import { AMBIGUOUS_MESSAGE, MAX_ACCEPTED_AGE_MS, PUBLISH_POLL_STEP, pollDelayMs, publishPath, runApiPublish } from "./engine";
import { outcomeFromError, validateOutcome, type PublishOutcome, type PublishingProvider } from "./contract";

const WS = "11111111-1111-4111-8111-111111111111";
const KEY = "publish:v1:v1:1790000000";

function setup(opts: { variantState?: string; receipts?: Record<string, unknown>[]; task?: Record<string, unknown> } = {}) {
  const db = createMemorySupabase(
    {
      editorial_variants: [{ id: "v1", workspace_id: WS, channel_id: "ch1", publish_state: opts.variantState ?? "scheduled", attempt_count: 0, idempotency_key: KEY }],
      publish_receipts: opts.receipts ?? [],
      execution_records: [],
      task_events: [],
    },
    {
      defaults: { publish_receipts: () => ({ poll_count: 0, operation_ref: null, external_ref: null, external_url: null, error_message: null }) },
      constraints: {
        publish_receipts: (r, rows) => (rows.some((x) => x.idempotency_key === r.idempotency_key && x.attempt === r.attempt && x.id !== r.id) ? "23505" : null),
      },
    },
  );
  const executions: { operation: string }[] = [];
  const events: string[] = [];
  const ctx = {
    task: { id: "t1", workspace_id: WS, idempotency_key: KEY, attempts: 1, retry_policy: { maxAttempts: 3 }, human_intervention: "none", correlation_id: "c1", ...opts.task },
    supabase: db.client,
    budget: readBudget({}),
    deadline: Date.now() + 20_000,
    event: async (_l: string, m: string) => void events.push(m),
    execute: async <T,>(i: { operation: string }, fn: () => Promise<T>) => {
      executions.push({ operation: i.operation });
      return fn();
    },
  };
  return { db, ctx: ctx as never, executions, events, variant: () => db.tables.editorial_variants[0], receipts: () => db.tables.publish_receipts };
}

function provider(overrides: Partial<PublishingProvider> & { submits?: PublishOutcome[]; statuses?: PublishOutcome[] } = {}) {
  const calls = { submit: 0, status: 0 };
  const p: PublishingProvider & { calls: typeof calls } = {
    id: "fake",
    platforms: ["telegram"],
    idempotentSubmit: false,
    capability: () => ({ level: "available", reason: "fake" }),
    async submit() {
      calls.submit++;
      const o = overrides.submits?.shift();
      if (!o) throw new Error("unexpected submit");
      return o;
    },
    async status() {
      calls.status++;
      const o = overrides.statuses?.shift();
      if (!o) throw new Error("unexpected status");
      return o;
    },
    ...overrides,
    calls,
  };
  return p;
}

const request = { workspaceId: WS, variantId: "v1", channelId: "ch1", accountRef: "acc", platform: "telegram", kind: "post" as const, text: "hi", media: [], idempotencyKey: KEY };
const run = (s: ReturnType<typeof setup>, p: PublishingProvider) =>
  runApiPublish(s.ctx, { provider: p, platform: "telegram", request, variant: { id: "v1", channel_id: "ch1", publish_state: s.variant().publish_state as never, attempt_count: s.variant().attempt_count as number } });

describe("publishPath", () => {
  it("walks only legal transitions through scheduled/publishing", () => {
    expect(publishPath("scheduled", "published")).toEqual(["publishing", "published"]);
    expect(publishPath("failed", "published")).toEqual(["scheduled", "publishing", "published"]);
    expect(publishPath("failed", "publishing")).toEqual(["scheduled", "publishing"]);
    expect(publishPath("queued", "failed")).toEqual(["failed"]);
    expect(publishPath("publishing", "publishing")).toEqual([]);
    expect(publishPath("published", "failed")).toBeNull();
  });
  it("backs off polling within bounds", () => {
    expect(pollDelayMs(0)).toBe(15_000);
    expect(pollDelayMs(3)).toBe(120_000);
    expect(pollDelayMs(20)).toBe(600_000);
    expect(pollDelayMs(0, 90_000)).toBe(90_000);
  });
});

describe("runApiPublish", () => {
  it("publishes synchronously and records a settled receipt", async () => {
    const s = setup();
    const p = provider({ submits: [{ status: "published", externalRef: "m1", externalUrl: "https://t.me/b/1" }] });
    const out = await run(s, p);
    expect(out).toMatchObject({ status: "completed", result: { externalRef: "m1", provider: "fake" } });
    expect(s.variant()).toMatchObject({ publish_state: "published", external_url: "https://t.me/b/1", attempt_count: 1 });
    expect(s.receipts()).toHaveLength(1);
    expect(s.receipts()[0]).toMatchObject({ status: "published", attempt: 1, mode: "api", provider: "fake", idempotency_key: KEY });
    expect(s.executions.map((e) => e.operation)).toEqual(["publish_post"]);
  });

  it("defers accepted operations and polls instead of resubmitting", async () => {
    const s = setup();
    const p = provider({
      submits: [{ status: "accepted", operationRef: "op-1", pollAfterMs: 1_000 }],
      statuses: [{ status: "accepted", operationRef: "op-1" }, { status: "published", externalRef: "post-9", externalUrl: null }],
    });
    const first = await run(s, p);
    expect(first).toMatchObject({ status: "deferred", step: `${PUBLISH_POLL_STEP}${s.receipts()[0].id}` });
    expect(s.variant().publish_state).toBe("publishing");
    expect(s.receipts()[0]).toMatchObject({ status: "accepted", operation_ref: "op-1" });

    const second = await run(s, p); // variant is `publishing` now
    expect(second.status).toBe("deferred");
    expect(s.receipts()[0].poll_count).toBe(1);

    const third = await run(s, p);
    expect(third).toMatchObject({ status: "completed", result: { externalRef: "post-9" } });
    expect(p.calls).toEqual({ submit: 1, status: 2 });
    expect(s.receipts()).toHaveLength(1);
    expect(s.receipts()[0].status).toBe("published");
    expect(s.variant()).toMatchObject({ publish_state: "published", attempt_count: 1 });
    expect(s.executions.map((e) => e.operation)).toEqual(["publish_post", "publish_status", "publish_status"]);
  });

  it("treats a failed status read as still pending, and gives up after 24h", async () => {
    const s = setup({
      variantState: "publishing",
      receipts: [{ id: "r1", workspace_id: WS, variant_id: "v1", idempotency_key: KEY, attempt: 1, status: "accepted", operation_ref: "op", poll_count: 0, created_at: new Date().toISOString() }],
    });
    const p = provider({ status: async () => { throw new TaskError("transient", "gateway 502"); } });
    expect((await run(s, p)).status).toBe("deferred");
    expect(s.receipts()[0].status).toBe("accepted");

    s.receipts()[0].created_at = new Date(Date.now() - MAX_ACCEPTED_AGE_MS - 1000).toISOString();
    await expect(run(s, p)).rejects.toMatchObject({ errorClass: "unknown_outcome" });
    expect(s.receipts()[0].status).toBe("unknown");
    expect(s.variant().publish_state).toBe("failed");
  });

  it("never resubmits after a crash mid-submit unless the provider is idempotent", async () => {
    const crashed = { id: "r1", workspace_id: WS, variant_id: "v1", idempotency_key: KEY, attempt: 1, status: "submitting", poll_count: 0, created_at: new Date().toISOString() };
    const s = setup({ variantState: "publishing", receipts: [{ ...crashed }], task: { attempts: 2 } });
    const p = provider();
    await expect(run(s, p)).rejects.toMatchObject({ errorClass: "unknown_outcome", message: AMBIGUOUS_MESSAGE });
    expect(p.calls.submit).toBe(0);
    expect(s.receipts()[0].status).toBe("unknown");
    expect(s.variant().publish_state).toBe("failed");

    // Operator retried the job from Jobs (human_intervention=resolved) → resubmit, new attempt number.
    const again = setup({ variantState: "failed", receipts: [{ ...crashed, status: "unknown" }], task: { attempts: 3, human_intervention: "resolved" } });
    const p2 = provider({ submits: [{ status: "published", externalRef: "x", externalUrl: null }] });
    expect((await run(again, p2)).status).toBe("completed");
    expect(again.receipts().map((r) => [r.attempt, r.status])).toEqual([[1, "unknown"], [3, "published"]]);

    // Idempotent providers may resubmit a crashed attempt automatically.
    const idem = setup({ variantState: "publishing", receipts: [{ ...crashed }], task: { attempts: 2 } });
    const p3 = provider({ idempotentSubmit: true, submits: [{ status: "published", externalRef: "x", externalUrl: null }] });
    expect((await run(idem, p3)).status).toBe("completed");
    expect(p3.calls.submit).toBe(1);
  });

  it("treats a legacy `publishing` variant without receipts as ambiguous", async () => {
    const s = setup({ variantState: "publishing" });
    await expect(run(s, provider())).rejects.toMatchObject({ errorClass: "unknown_outcome" });
    expect(s.receipts()).toHaveLength(0);
  });

  it("finishes a published receipt whose variant update was lost, without resubmitting", async () => {
    const s = setup({
      variantState: "publishing",
      receipts: [{ id: "r1", workspace_id: WS, variant_id: "v1", idempotency_key: KEY, attempt: 1, status: "published", external_ref: "p1", external_url: "https://x.test/p1", poll_count: 0, created_at: "2026-01-01" }],
    });
    const p = provider();
    expect(await run(s, p)).toMatchObject({ status: "completed", result: { recovered: true, externalRef: "p1" } });
    expect(p.calls.submit).toBe(0);
    expect(s.variant()).toMatchObject({ publish_state: "published", external_url: "https://x.test/p1" });
  });

  it("stops terminally on partial success and keeps the live parts on the receipt", async () => {
    const s = setup();
    const parts = [{ index: 0, status: "published" as const, externalRef: "t1" }, { index: 1, status: "failed" as const, message: "too long" }];
    const p = provider({ submits: [{ status: "partial", externalRef: "t1", externalUrl: null, parts, message: "Thread stopped at part 2." }] });
    const err = await run(s, p).catch((e) => e as TaskError);
    expect(err).toMatchObject({ errorClass: "unknown_outcome", options: { terminal: true } });
    expect(s.receipts()[0]).toMatchObject({ status: "partial", external_ref: "t1" });
    expect((s.receipts()[0].parts as unknown[]).length).toBe(2);
    expect(s.variant()).toMatchObject({ publish_state: "failed" });
    expect(String(s.variant().last_error)).toMatch(/1 of 2 parts live/);

    // A retry of the same schedule never resubmits a partial publication.
    await expect(run(s, p)).rejects.toMatchObject({ options: { terminal: true } });
    expect(p.calls.submit).toBe(1);
  });

  it("classifies failures: retryable → queued, final/validation → failed", async () => {
    const s = setup();
    await expect(run(s, provider({ submits: [{ status: "failed", errorClass: "rate_limited", message: "slow", retryAfterMs: 60_000 }] }))).rejects.toMatchObject({ errorClass: "rate_limited", options: { retryAfterMs: 60_000 } });
    expect(s.variant()).toMatchObject({ publish_state: "queued", last_error: "slow" });
    expect(s.receipts()[0]).toMatchObject({ status: "failed", error_class: "rate_limited" });

    const s2 = setup();
    await expect(run(s2, provider({ submits: [{ status: "failed", errorClass: "transient", message: "dead-lettered", final: true }] }))).rejects.toMatchObject({ options: { terminal: true } });
    expect(s2.variant().publish_state).toBe("failed");

    const s3 = setup({ task: { attempts: 3 } });
    await expect(run(s3, provider({ submits: [{ status: "failed", errorClass: "transient", message: "x" }] }))).rejects.toThrow("x");
    expect(s3.variant().publish_state).toBe("failed");
  });

  it("maps thrown ambiguous errors to unknown unless the provider is idempotent", async () => {
    const s = setup();
    const p = provider({ submit: async () => { throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" }); } });
    await expect(run(s, p)).rejects.toMatchObject({ errorClass: "unknown_outcome" });
    expect(s.receipts()[0].status).toBe("unknown");

    const s2 = setup();
    const p2 = provider({ idempotentSubmit: true, submit: async () => { throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" }); } });
    await expect(run(s2, p2)).rejects.toMatchObject({ errorClass: "transient" });
    expect(s2.variant().publish_state).toBe("queued");

    const s3 = setup();
    const p3 = provider({ submit: async () => ({ status: "weird" }) as never });
    await expect(run(s3, p3)).rejects.toMatchObject({ errorClass: "unknown_outcome" });
  });

  it("refuses unavailable capabilities before any provider call or receipt", async () => {
    const s = setup();
    const p = provider({ capability: () => ({ level: "unavailable", reason: "Gateway contract pending" }) });
    await expect(run(s, p)).rejects.toMatchObject({ errorClass: "unsupported_capability" });
    expect(p.calls.submit).toBe(0);
    expect(s.receipts()).toHaveLength(0);
    expect(s.variant()).toMatchObject({ publish_state: "failed", last_error: "Gateway contract pending" });
  });

  it("does not submit when another executor already recorded the same attempt", async () => {
    const s = setup();
    s.db.failNext("publish_receipts", "insert", "23505");
    const p = provider();
    await expect(run(s, p)).rejects.toMatchObject({ errorClass: "unknown_outcome" });
    expect(p.calls.submit).toBe(0);
  });

  it("numbers attempts after earlier receipts of the same schedule", async () => {
    const s = setup({
      receipts: [{ id: "rX", workspace_id: WS, variant_id: "v1", idempotency_key: KEY, attempt: 1, status: "failed", poll_count: 0, created_at: "2026-01-01" }],
      task: { attempts: 1 },
    });
    // prior attempt 1 failed → next attempt is 2 even though task.attempts is 1
    const p = provider({ submits: [{ status: "published", externalRef: null, externalUrl: null }] });
    await run(s, p);
    expect(s.receipts().map((r) => r.attempt)).toEqual([1, 2]);
  });
});

describe("contract helpers", () => {
  it("validates provider outcomes defensively", () => {
    expect(validateOutcome({ status: "published", externalRef: "a", externalUrl: "http://insecure" })).toEqual({ status: "published", externalRef: "a", externalUrl: null });
    expect(() => validateOutcome({ status: "accepted" })).toThrow(/operation reference/);
    expect(validateOutcome({ status: "failed", errorClass: "bogus", message: "m" })).toMatchObject({ errorClass: "internal" });
    expect(validateOutcome({ status: "failed", errorClass: "unknown_outcome", message: "m" })).toMatchObject({ status: "unknown" });
    expect(outcomeFromError(new TaskError("validation", "bad"), false)).toMatchObject({ status: "failed", errorClass: "validation" });
    expect(outcomeFromError(new Error("boom"), false)).toMatchObject({ status: "unknown" });
    expect(outcomeFromError(new Error("boom"), true)).toMatchObject({ status: "failed", errorClass: "internal" });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { log, redact, setLogSink } from "./log";
import { increment, observe, resetMetrics, snapshot } from "./metrics";
import { readBudget, assertComputeAllowed, PaidComputeRefusedError } from "@/lib/runtime/budget";

afterEach(() => resetMetrics());

describe("structured logging", () => {
  it("redacts secret-looking keys and values, keeps identity fields", () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    log("info", "task.completed", {
      correlationId: "c1",
      workspaceId: "w1",
      headers: { authorization: "Bearer abc", cookie: "sid=1" },
      apiKey: "sk-123",
      note: "token zfw_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 leaked",
    });
    restore();
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ level: "info", event: "task.completed", correlationId: "c1", workspaceId: "w1" });
    expect(entry.headers).toEqual({ authorization: "[REDACTED]", cookie: "[REDACTED]" });
    expect(entry.apiKey).toBe("[REDACTED]");
    expect(entry.note).not.toContain("zfw_ABCDEFGH");
  });
  it("bounds depth and array size", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
    expect(JSON.stringify(redact(deep))).toContain("TRUNCATED");
    expect((redact(Array.from({ length: 100 }, (_, i) => i)) as unknown[]).length).toBe(50);
  });
});

describe("metrics", () => {
  it("counts and summarizes with sorted labels", () => {
    increment("tasks_total", { outcome: "completed", kind: "x" });
    increment("tasks_total", { kind: "x", outcome: "completed" });
    observe("latency", 10);
    observe("latency", 30);
    const s = snapshot();
    expect(s.counters["tasks_total{kind=x,outcome=completed}"]).toBe(2);
    expect(s.summaries.latency).toEqual({ count: 2, sum: 40, max: 30 });
  });
});

describe("zero-cost budget", () => {
  it("defaults to the free-tier safeguards", () => {
    expect(readBudget({})).toEqual({
      paidComputeAllowed: false,
      maxBackgroundWorkers: 1,
      maxTasksPerTick: 10,
      tickTimeBudgetMs: 25_000,
      maxBrowserConcurrency: 1,
      browserIdleShutdown: true,
      maxUploadSizeBytes: 104_857_600,
      maxArtifactRetentionDays: 30,
      maxWorkspaceStorageBytes: 5_368_709_120,
    });
  });
  it("clamps hostile values and honors the legacy MAX_UPLOAD_SIZE name", () => {
    const b = readBudget({ MAX_BACKGROUND_WORKERS: "999", MAX_BROWSER_CONCURRENCY: "-3", MAX_UPLOAD_SIZE: "1000" });
    expect(b.maxBackgroundWorkers).toBe(8);
    expect(b.maxBrowserConcurrency).toBe(0);
    expect(b.maxUploadSizeBytes).toBe(1000);
  });
  it("refuses paid adapters unless explicitly allowed", () => {
    expect(() => assertComputeAllowed({ name: "hosted-browser", paid: true }, readBudget({}))).toThrow(PaidComputeRefusedError);
    expect(() => assertComputeAllowed({ name: "local", paid: false }, readBudget({}))).not.toThrow();
  });
});

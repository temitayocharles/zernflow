import { describe, expect, it } from "vitest";
import { ago, assessHealth, overall, type HealthInputs } from "./assess";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const base: HealthInputs = {
  now: NOW, nodeEnv: "production",
  tick: { lastRunAt: "2026-09-25T11:58:00Z", lastOkAt: "2026-09-25T11:58:00Z", status: "ok", failedStages: [] },
  jobs: { dueQueued: 0, oldestDueAt: null, running: 0, waitingForUser: 0, failed24h: 0 },
  workers: [{ name: "browser", lastSeenAt: "2026-09-25T10:00:00Z", revoked: false, modes: ["browser"] }],
  gateway: { configured: true, lastCheck: { state: "completed", finishedAt: "2026-09-25T11:00:00Z", error: null } },
  secrets: { configured: true, provider: "vault-transit", localAllowed: false },
  storage: { configured: true, usedBytes: 10, capBytes: 100 },
  publishing: { failed: 0, manualDue: 0 },
  budget: { paidComputeAllowed: false, maxBackgroundWorkers: 1, maxBrowserConcurrency: 1, browserIdleShutdown: true },
};
const by = (i: HealthInputs) => Object.fromEntries(assessHealth(i).map((c) => [c.id, c]));

describe("assessHealth", () => {
  it("is healthy on the free-tier profile", () => {
    expect(overall(assessHealth(base))).toBe("ok");
  });

  it("flags stale or missing ticks as failures with an action", () => {
    expect(by({ ...base, tick: null }).tick).toMatchObject({ status: "fail", action: expect.stringMatching(/cron/) });
    expect(by({ ...base, tick: { ...base.tick!, lastRunAt: "2026-09-25T11:00:00Z" } }).tick.status).toBe("fail");
    expect(by({ ...base, tick: { ...base.tick!, status: "degraded", failedStages: ["tasks"] } }).tick).toMatchObject({ status: "warn", detail: expect.stringMatching(/tasks/) });
  });

  it("warns about backlog, operator actions, and guardrail drift but never suggests scaling up", () => {
    const jobs = by({ ...base, jobs: { ...base.jobs!, dueQueued: 40, oldestDueAt: "2026-09-25T11:00:00Z" } }).jobs;
    expect(jobs.status).toBe("warn");
    expect(jobs.action).toMatch(/no automatic scaling/);
    expect(by({ ...base, budget: { ...base.budget, paidComputeAllowed: true } }).budget.status).toBe("warn");
  });

  it("reports unconfigured dependencies without leaking values", () => {
    const r = by({ ...base, gateway: { configured: false, lastCheck: null }, secrets: { configured: false, provider: null, localAllowed: false }, storage: { configured: false, usedBytes: 0, capBytes: 1 } });
    expect(r.gateway.status).toBe("fail");
    expect(r.secrets.status).toBe("fail");
    expect(r.storage.status).toBe("warn");
    expect(by({ ...base, secrets: { configured: true, provider: "local", localAllowed: true } }).secrets.status).toBe("warn");
    expect(by({ ...base, workers: [] }).workers.status).toBe("unknown");
    expect(overall(assessHealth({ ...base, workers: [] }))).toBe("unknown");
  });

  it("formats ages", () => {
    expect(ago(Infinity)).toBe("never");
    expect(ago(5 * 60_000)).toBe("5 min ago");
    expect(ago(3 * 86_400_000)).toBe("3 days ago");
  });
});

import { auditKeysetFilter, changedFields, mergeAudit, parseAuditCursor, type AuditEntry } from "./audit";
describe("audit merge", () => {
  const e = (id: string, at: string, source: AuditEntry["source"]): AuditEntry => ({ id, at, source, actorId: null, actorType: "system", action: "x", entityType: "t", entityId: null, outcome: "success", detail: "" });
  it("interleaves sources newest-first and returns a cursor", () => {
    const out = mergeAudit([e("r1", "2026-09-25T10:00:00Z", "records"), e("r2", "2026-09-25T08:00:00Z", "records")], [e("s1", "2026-09-25T09:00:00Z", "secrets")], 2);
    expect(out.entries.map((x) => x.id)).toEqual(["r1", "s1"]);
    expect(out.nextBefore).toBe("2026-09-25T09:00:00Z|s1");
    expect(mergeAudit([], [], 5)).toEqual({ entries: [], nextBefore: null });
  });
  it("orders by (timestamp with microseconds, id) and emits a keyset cursor", () => {
    const a = e("a0000000-0000-4000-8000-000000000001", "2026-09-25T10:00:00.123456+00:00", "records");
    const b = e("b0000000-0000-4000-8000-000000000002", "2026-09-25T10:00:00.123457+00:00", "secrets");
    const c = e("c0000000-0000-4000-8000-000000000003", "2026-09-25T10:00:00.123456+00:00", "secrets");
    const d = e("d0000000-0000-4000-8000-000000000004", "2026-09-25T06:00:00.5-04:00", "records"); // = 10:00:00.500 UTC
    const out = mergeAudit([a, d], [b, c], 3);
    expect(out.entries.map((x) => x.id[0])).toEqual(["d", "b", "c"]);
    expect(out.nextBefore).toBe(`2026-09-25T10:00:00.123456+00:00|${c.id}`);
    // Same-microsecond rows on the page boundary are split by id, never skipped.
    expect(auditKeysetFilter(parseAuditCursor(out.nextBefore)!)).toEqual({
      or: `created_at.lt."2026-09-25T10:00:00.123456+00:00",and(created_at.eq."2026-09-25T10:00:00.123456+00:00",id.lt.${c.id})`,
    });
  });

  it("parses cursors strictly (no filter injection) and accepts legacy timestamp links", () => {
    expect(parseAuditCursor("2026-09-25T10:00:00Z")).toEqual({ at: "2026-09-25T10:00:00Z", id: null });
    expect(auditKeysetFilter({ at: "2026-09-25T10:00:00Z", id: null })).toEqual({ lt: "2026-09-25T10:00:00Z" });
    expect(parseAuditCursor("2026-09-25T10:00:00Z|A0000000-0000-4000-8000-000000000001")?.id).toBe("a0000000-0000-4000-8000-000000000001");
    for (const bad of ["2026-09-25T10:00:00Z|x),id.gt.0", "2026-09-25T10:00:00Z|a|b", "yesterday", "", "2026-09-25T10:00:00Z,or(id.gt.0)"]) {
      expect(parseAuditCursor(bad)).toBeNull();
    }
  });

  it("never exposes changed values", () => {
    expect(changedFields({ body: "secret text", version: 2, name: "x" })).toBe("fields: body, name");
    expect(changedFields(null)).toBe("");
  });
  it("reports legacy queue routing and warns only when the legacy drain falls behind", () => {
    const routes = { resume_flow: "tasks", send_broadcast: "scheduled_jobs", process_social_gateway_event: "scheduled_jobs" } as const;
    const ok = by({ ...base, legacyQueue: { routes, pending: 2, oldestPendingAt: "2026-09-25T11:55:00Z" } }).legacyQueue;
    expect(ok).toMatchObject({ status: "ok", detail: expect.stringMatching(/1\/3 legacy producers.*resume_flow→tasks/) });
    const behind = by({ ...base, legacyQueue: { routes, pending: 9, oldestPendingAt: "2026-09-25T10:00:00Z" } }).legacyQueue;
    expect(behind).toMatchObject({ status: "warn", action: expect.stringMatching(/legacyJobs/) });
    expect(by({ ...base, legacyQueue: null }).legacyQueue.status).toBe("unknown");
    expect(by(base).legacyQueue).toBeUndefined();
  });
});

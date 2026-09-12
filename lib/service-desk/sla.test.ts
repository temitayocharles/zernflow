import { describe, expect, it } from "vitest";
import { evaluateSlaObjective, evaluateTicketSla, resolveSlaTargets, type SlaPolicy } from "./sla";
const start = "2026-09-11T00:00:00Z";
const at = (minutes: number) => new Date(Date.parse(start) + minutes * 60_000).toISOString();
const base = { startedAt: start, targetMinutes: 60, warningFraction: 0.8, now: at(0) };
const policy: SlaPolicy = { targets: { firstResponseMinutes: 60, resolutionMinutes: 240 }, warningFraction: 0.8, priorityOverrides: { urgent: { firstResponseMinutes: 15 } } };
describe("calendar-time SLA engine", () => {
  it("resolves per-priority overrides without mutating defaults", () => {
    expect(resolveSlaTargets(policy, "urgent")).toEqual({ firstResponseMinutes: 15, resolutionMinutes: 240 });
    expect(resolveSlaTargets(policy, "normal")).toEqual(policy.targets);
  });
  it.each([[0, "on_track"], [47, "on_track"], [48, "warning"], [59, "warning"], [60, "breached"], [61, "breached"]])("evaluates minute %s as %s", (minute, state) => {
    const result = evaluateSlaObjective({ ...base, now: at(Number(minute)) });
    expect(result.state).toBe(state);
    expect(result.dueAt).toBe(at(60));
  });
  it("distinguishes completed at deadline from completed late without escalating closed work", () => {
    expect(evaluateSlaObjective({ ...base, now: at(100), completedAt: at(60) }).state).toBe("met");
    expect(evaluateSlaObjective({ ...base, now: at(100), completedAt: at(61) })).toMatchObject({ state: "breached", escalationRequired: false, remainingMs: -60_000 });
  });
  it("freezes budget for an open pause", () => {
    expect(evaluateSlaObjective({ ...base, now: at(100), pauses: [{ startedAt: at(20), endedAt: null }] })).toMatchObject({ state: "paused", dueAt: at(140), remainingMs: 40 * 60_000 });
  });
  it("does not hide a breach when paused late", () => {
    expect(evaluateSlaObjective({ ...base, now: at(100), pauses: [{ startedAt: at(61), endedAt: null }] })).toMatchObject({ state: "breached", paused: true, escalationRequired: true });
  });
  it("sums disjoint pauses irrespective of input order", () => {
    expect(evaluateSlaObjective({ ...base, now: at(60), pauses: [{ startedAt: at(30), endedAt: at(40) }, { startedAt: at(10), endedAt: at(20) }] })).toMatchObject({ dueAt: at(80), remainingMs: 20 * 60_000 });
  });
  it("clips pause accounting at completion", () => {
    expect(evaluateSlaObjective({ ...base, now: at(100), completedAt: at(50), pauses: [{ startedAt: at(20), endedAt: at(80) }] })).toMatchObject({ state: "met", dueAt: at(90), remainingMs: 40 * 60_000 });
  });
  it("keeps first response independent from resolution pauses", () => {
    const result = evaluateTicketSla({ policy, priority: "urgent", createdAt: start, now: at(30), resolutionPauses: [{ startedAt: at(10), endedAt: null }] });
    expect(result.firstResponse.state).toBe("breached");
    expect(result.resolution.state).toBe("paused");
  });
  it("handles equivalent timezone offsets deterministically", () => {
    expect(evaluateSlaObjective({ ...base, startedAt: "2026-09-11T02:00:00+02:00" }).dueAt).toBe(at(60));
  });
  it.each([0, -1, 1.5, Infinity, NaN, 525601])("rejects invalid target %s", targetMinutes => {
    expect(() => evaluateSlaObjective({ ...base, targetMinutes })).toThrow();
  });
  it.each([0, 1, -1, NaN])("rejects invalid warning fraction %s", warningFraction => {
    expect(() => evaluateSlaObjective({ ...base, warningFraction })).toThrow();
  });
  it("rejects invalid chronology, timezone-free dates and overlapping pauses", () => {
    expect(() => evaluateSlaObjective({ ...base, now: at(-1) })).toThrow();
    expect(() => evaluateSlaObjective({ ...base, completedAt: at(1) })).toThrow();
    expect(() => evaluateSlaObjective({ ...base, startedAt: "2026-09-11T00:00:00" })).toThrow();
    expect(() => evaluateSlaObjective({ ...base, now: at(60), pauses: [{ startedAt: at(10), endedAt: at(30) }, { startedAt: at(20), endedAt: null }] })).toThrow();
    expect(() => evaluateSlaObjective({ ...base, now: at(60), pauses: [{ startedAt: at(10), endedAt: null }, { startedAt: at(40), endedAt: null }] })).toThrow();
  });
});

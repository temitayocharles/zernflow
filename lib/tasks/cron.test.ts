import { describe, expect, it } from "vitest";
import { CronError, firstRun, followingRun, nextCronRun, parseCron } from "./cron";

describe("cron", () => {
  it("parses lists, ranges and steps", () => {
    const spec = parseCron("*/15 9-17 * * 1-5");
    expect([...spec.minutes]).toEqual([0, 15, 30, 45]);
    expect(spec.hours.has(9) && spec.hours.has(17) && !spec.hours.has(18)).toBe(true);
    expect([...spec.daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(CronError);
    expect(() => parseCron("61 * * * *")).toThrow(CronError);
    expect(() => parseCron("a * * * *")).toThrow(CronError);
  });
  it("computes the next weekday 09:00 in a time zone, across DST", () => {
    // Friday 2026-03-06 10:00 Toronto (EST, UTC-5) → Monday 2026-03-09 09:00 EDT (UTC-4)
    const next = nextCronRun("0 9 * * 1-5", "America/Toronto", new Date("2026-03-06T15:00:00Z"));
    expect(next.toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });
  it("treats day-of-month and day-of-week as OR when both are restricted", () => {
    const next = nextCronRun("0 0 1 * 1", "UTC", new Date("2026-09-25T00:00:00Z")); // Fri
    expect(next.toISOString()).toBe("2026-09-28T00:00:00.000Z"); // Monday before the 1st
  });
  it("skips missed interval runs instead of replaying a backlog", () => {
    const expected = new Date("2026-09-25T00:00:00Z");
    const now = new Date("2026-09-25T05:30:00Z");
    expect(followingRun({ cron: null, interval_seconds: 3600, timezone: "UTC" }, expected, now).toISOString()).toBe(
      "2026-09-25T06:00:00.000Z",
    );
    expect(firstRun({ cron: null, interval_seconds: 600, timezone: "UTC" }, now).toISOString()).toBe(
      "2026-09-25T05:40:00.000Z",
    );
  });
  it("rejects unknown time zones", () => {
    expect(() => nextCronRun("* * * * *", "Mars/Olympus", new Date())).toThrow(/time zone/);
  });
});

/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week) with IANA
 * timezone support. Supports `*`, lists, ranges and steps. When both
 * day-of-month and day-of-week are restricted, either may match (Vixie cron).
 */
export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export class CronError extends Error {}

function parseField(field: string, min: number, max: number): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  const restricted = field !== "*";
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new CronError(`Invalid cron field "${field}"`);
    const [, range, stepRaw] = match;
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new CronError(`Invalid step in "${field}"`);
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-").map(Number);
      lo = a;
      hi = b ?? (stepRaw ? max : a);
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`Out-of-range value in "${field}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, restricted };
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError("Cron expressions need exactly 5 fields");
  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12);
  const dowRaw = parseField(fields[4], 0, 7);
  const daysOfWeek = new Set([...dowRaw.values].map((d) => (d === 7 ? 0 : d)));
  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: dom.values,
    months: months.values,
    daysOfWeek,
    domRestricted: dom.restricted,
    dowRestricted: dowRaw.restricted,
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(date: Date, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdays[parts.weekday as string],
  };
}

function dayMatches(spec: CronSpec, p: ReturnType<typeof localParts>): boolean {
  if (!spec.months.has(p.month)) return false;
  const dom = spec.daysOfMonth.has(p.day);
  const dow = spec.daysOfWeek.has(p.weekday);
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  if (spec.domRestricted) return dom;
  if (spec.dowRestricted) return dow;
  return true;
}

/** First matching minute strictly after `after`, searching up to ~5 years. */
export function nextCronRun(expression: string, timeZone: string, after: Date): Date {
  if (!isValidTimeZone(timeZone)) throw new CronError(`Unknown time zone "${timeZone}"`);
  const spec = parseCron(expression);
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 5 * 366 * 86_400_000;
  while (t < limit) {
    const p = localParts(new Date(t), timeZone);
    if (!dayMatches(spec, p)) {
      t += ((23 - p.hour) * 60 + (60 - p.minute)) * 60_000; // next local midnight
      continue;
    }
    if (!spec.hours.has(p.hour)) {
      t += (60 - p.minute) * 60_000;
      continue;
    }
    if (!spec.minutes.has(p.minute)) {
      t += 60_000;
      continue;
    }
    return new Date(t);
  }
  throw new CronError("Cron expression never matches");
}

export interface ScheduleTiming {
  cron: string | null;
  interval_seconds: number | null;
  timezone: string;
}

/**
 * The run after `expected`, skipping runs missed while ZernFlow was offline
 * (one catch-up run is materialized, not a backlog).
 */
export function followingRun(schedule: ScheduleTiming, expected: Date, now: Date): Date {
  const floor = new Date(Math.max(expected.getTime(), now.getTime()));
  if (schedule.cron) return nextCronRun(schedule.cron, schedule.timezone, floor);
  const intervalMs = (schedule.interval_seconds ?? 3600) * 1000;
  const periods = Math.floor((floor.getTime() - expected.getTime()) / intervalMs) + 1;
  return new Date(expected.getTime() + periods * intervalMs);
}

export function firstRun(schedule: ScheduleTiming, now: Date): Date {
  if (schedule.cron) return nextCronRun(schedule.cron, schedule.timezone, now);
  return new Date(now.getTime() + (schedule.interval_seconds ?? 3600) * 1000);
}

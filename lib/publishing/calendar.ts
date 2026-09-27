/** Pure helpers for the month calendar (timezone-aware, no Date.now in render). */

export function validTimeZone(tz: string | null | undefined): string | null {
  if (!tz || tz.length > 100) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** YYYY-MM-DD of an instant in a timezone. */
export function dayKey(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function parseMonth(value: string | undefined, fallback: Date): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(value ?? "");
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { year: Number(m[1]), month: Number(m[2]) };
  return { year: fallback.getUTCFullYear(), month: fallback.getUTCMonth() + 1 };
}

export function shiftMonth(year: number, month: number, delta: number): string {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Weeks (Mon–Sun) covering the month, as YYYY-MM-DD keys with an in-month flag. */
export function monthGrid(year: number, month: number): { key: string; day: number; inMonth: boolean }[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(year, month - 1, 1 - offset));
  const weeks: { key: string; day: number; inMonth: boolean }[][] = [];
  const cursor = new Date(start);
  do {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push({ key: cursor.toISOString().slice(0, 10), day: cursor.getUTCDate(), inMonth: cursor.getUTCMonth() === month - 1 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
  } while (cursor.getUTCMonth() === month - 1);
  return weeks;
}

/** Query window padded by 14h each side so any timezone's local days are covered. */
export function monthWindow(year: number, month: number): { from: string; to: string } {
  const from = new Date(Date.UTC(year, month - 1, 1) - 14 * 3600_000);
  const to = new Date(Date.UTC(year, month, 1) + 14 * 3600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function nowDate(): Date {
  return new Date();
}

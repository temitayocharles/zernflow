/** 5-field cron for the content Repeat form (daily / weekly / monthly at a local time). */
export function repeatCron(frequency: string, time: string, weekday: number, monthDay: number): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return null;
  if (frequency === "daily") return `${min} ${h} * * *`;
  if (frequency === "weekly" && weekday >= 0 && weekday <= 6) return `${min} ${h} * * ${weekday}`;
  if (frequency === "monthly" && monthDay >= 1 && monthDay <= 28) return `${min} ${h} ${monthDay} * *`;
  return null;
}


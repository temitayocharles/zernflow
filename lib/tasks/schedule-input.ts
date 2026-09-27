import { InputError, object, text } from "@/lib/product/validation";
import type { Json } from "@/lib/types/database";
import { getHandler } from "./handlers";
import { CronError, firstRun, isValidTimeZone, parseCron } from "./cron";

export interface ScheduleDraft {
  name: string;
  kind: string;
  input: Record<string, Json>;
  execution_mode: "internal" | "api" | "browser" | "human";
  cron: string | null;
  interval_seconds: number | null;
  timezone: string;
  enabled: boolean;
  next_run_at: string;
}

/** Validates a schedule definition against the handler registry and cron rules. */
export function parseScheduleInput(value: unknown, now = new Date()): ScheduleDraft {
  const body = object(value);
  const kind = text(body.kind, "kind", 100, true);
  const handler = getHandler(kind);
  if (!handler || !handler.schedulable) throw new InputError("This task kind cannot be scheduled");
  const input = handler.parseInput(body.input ?? {}) as Record<string, Json>;
  const timezone = body.timezone === undefined ? "UTC" : text(body.timezone, "timezone", 64, true);
  if (!isValidTimeZone(timezone)) throw new InputError("Unknown time zone");
  const cron = body.cron === undefined || body.cron === null || body.cron === "" ? null : text(body.cron, "cron", 120, true);
  const interval = body.intervalSeconds === undefined || body.intervalSeconds === null ? null : body.intervalSeconds;
  if ((cron === null) === (interval === null)) throw new InputError("Provide exactly one of cron or intervalSeconds");
  if (interval !== null && (typeof interval !== "number" || !Number.isInteger(interval) || interval < 60 || interval > 31_536_000)) {
    throw new InputError("intervalSeconds must be an integer between 60 and 31536000");
  }
  if (cron) {
    try {
      parseCron(cron);
    } catch (error) {
      throw new InputError(error instanceof CronError ? error.message : "Invalid cron expression");
    }
  }
  const timing = { cron, interval_seconds: interval as number | null, timezone };
  return {
    name: text(body.name, "name", 200, true),
    kind,
    input,
    execution_mode: handler.mode,
    cron,
    interval_seconds: interval as number | null,
    timezone,
    enabled: body.enabled === undefined ? true : body.enabled === true,
    next_run_at: firstRun(timing, now).toISOString(),
  };
}

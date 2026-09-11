/** Calendar-time SLA calculations. Business hours/holidays require a separate calendar policy. */
export type WorkPriority = "low" | "normal" | "high" | "urgent";
export interface SlaTargets {
  firstResponseMinutes: number;
  resolutionMinutes: number;
}
export interface SlaPolicy {
  targets: SlaTargets;
  priorityOverrides?: Partial<Record<WorkPriority, Partial<SlaTargets>>>;
  /** Fraction of the budget consumed before warning, strictly between zero and one. */
  warningFraction: number;
}
export interface SlaPause {
  startedAt: string;
  endedAt: string | null;
}
export type SlaState = "on_track" | "warning" | "breached" | "paused" | "met";
export interface SlaResult {
  dueAt: string;
  state: SlaState;
  remainingMs: number;
  paused: boolean;
  completed: boolean;
  /** A signal for the owning execution system, not a dispatched escalation. */
  escalationRequired: boolean;
}
const MINUTE = 60_000;
function instant(value: string, name: string): number {
  // Require timezone information to avoid machine-local timezone dependence.
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error(`${name} requires an ISO timestamp with timezone`);
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`${name} is invalid`);
  return result;
}
function minutes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 525_600) throw new Error("SLA target must be an integer from 1 to 525600 minutes");
  return value;
}
export function resolveSlaTargets(policy: SlaPolicy, priority: WorkPriority): SlaTargets {
  if (!Number.isFinite(policy.warningFraction) || policy.warningFraction <= 0 || policy.warningFraction >= 1) throw new Error("warningFraction must be between zero and one");
  minutes(policy.targets.firstResponseMinutes);
  minutes(policy.targets.resolutionMinutes);
  const override = policy.priorityOverrides?.[priority];
  return {
    firstResponseMinutes: minutes(override?.firstResponseMinutes ?? policy.targets.firstResponseMinutes),
    resolutionMinutes: minutes(override?.resolutionMinutes ?? policy.targets.resolutionMinutes),
  };
}

/**
 * Evaluates a single objective as of an explicit clock. Completion is assessed
 * at completedAt even when now is later. Pauses freeze the remaining budget,
 * but never hide a breach that already occurred before the pause began.
 * Overlapping pause intervals are rejected rather than double-counted.
 */
export function evaluateSlaObjective(input: {
  startedAt: string;
  targetMinutes: number;
  warningFraction: number;
  now: string;
  completedAt?: string | null;
  pauses?: readonly SlaPause[];
}): SlaResult {
  const started = instant(input.startedAt, "startedAt");
  const now = instant(input.now, "now");
  const completed = input.completedAt ? instant(input.completedAt, "completedAt") : null;
  if (now < started || (completed !== null && (completed < started || completed > now))) throw new Error("SLA timestamps are out of order");
  if (!Number.isFinite(input.warningFraction) || input.warningFraction <= 0 || input.warningFraction >= 1) throw new Error("warningFraction must be between zero and one");
  const budget = minutes(input.targetMinutes) * MINUTE;
  const evaluated = completed ?? now;
  const pauses = (input.pauses ?? []).map(pause => ({
    start: instant(pause.startedAt, "pause.startedAt"),
    end: pause.endedAt === null ? null : instant(pause.endedAt, "pause.endedAt"),
  })).sort((a, b) => a.start - b.start);
  let previousEnd = started;
  let pauseMs = 0;
  let paused = false;
  for (const pause of pauses) {
    if (pause.start < previousEnd || pause.start < started || pause.start > now ||
        (pause.end !== null && (pause.end < pause.start || pause.end > now))) throw new Error("Invalid or overlapping SLA pause intervals");
    previousEnd = pause.end ?? Infinity;
    if (pause.start > evaluated) continue;
    const end = Math.min(pause.end ?? evaluated, evaluated);
    pauseMs += end - pause.start;
    if (completed === null && pause.end === null) paused = true;
  }
  const elapsed = evaluated - started - pauseMs;
  const remainingMs = budget - elapsed;
  // At the deadline an unfinished objective is breached; completion exactly at
  // the deadline meets the target. A completed late objective remains breached.
  const breached = completed === null ? remainingMs <= 0 : remainingMs < 0;
  const state: SlaState = breached ? "breached" : completed !== null ? "met" : paused ? "paused" : elapsed >= budget * input.warningFraction ? "warning" : "on_track";
  const due = started + budget + pauseMs;
  if (!Number.isFinite(due) || Math.abs(due) > 8.64e15) throw new Error("SLA deadline is out of range");
  return { dueAt: new Date(due).toISOString(), state, remainingMs, paused, completed: completed !== null, escalationRequired: breached && completed === null };
}

export function evaluateTicketSla(input: {
  policy: SlaPolicy;
  priority: WorkPriority;
  createdAt: string;
  now: string;
  firstRespondedAt?: string | null;
  resolvedAt?: string | null;
  /** Explicit objective-specific pauses; awaiting a customer need not pause first response. */
  firstResponsePauses?: readonly SlaPause[];
  resolutionPauses?: readonly SlaPause[];
}): { firstResponse: SlaResult; resolution: SlaResult } {
  const targets = resolveSlaTargets(input.policy, input.priority);
  const base = { startedAt: input.createdAt, now: input.now, warningFraction: input.policy.warningFraction };
  return {
    firstResponse: evaluateSlaObjective({ ...base, targetMinutes: targets.firstResponseMinutes, completedAt: input.firstRespondedAt, pauses: input.firstResponsePauses }),
    resolution: evaluateSlaObjective({ ...base, targetMinutes: targets.resolutionMinutes, completedAt: input.resolvedAt, pauses: input.resolutionPauses }),
  };
}

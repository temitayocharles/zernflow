import {
  choice,
  InputError,
  integer,
  object,
  text,
  timestamp,
  uuid,
} from "@/lib/product/validation";
import { evaluateTicketSla, type WorkPriority } from "./sla";
import type { WorkItem } from "@/lib/product/types";
export const workStatuses = [
  "open",
  "in_progress",
  "waiting",
  "resolved",
  "closed",
];
export const workPriorities = ["low", "normal", "high", "urgent"];
export function allowedTransitions(status: string): string[] {
  return status === "resolved"
    ? ["closed", "open"]
    : status === "closed"
      ? ["open"]
      : ["open", "in_progress", "waiting", "resolved"].filter(
          (s) => s !== status,
        );
}
export function parseWorkInput(value: unknown, update = false) {
  const input = object(value);
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, v] of Object.entries(input)) {
    if (key === "version" && update) {
      out.version = integer(v, key, 1);
      continue;
    }
    if (
      [
        "queue_id",
        "assignee_id",
        "contact_id",
        "company_id",
        "conversation_id",
      ].includes(key)
    )
      out[key] = v === null ? null : uuid(v, key);
    else if (
      key === "name" ||
      key === "description" ||
      key === "escalation_reason"
    )
      out[key] = text(
        v,
        key,
        key === "description"
          ? 10000
          : key === "escalation_reason"
            ? 2000
            : 200,
        key === "name",
      );
    else if (key === "priority") out[key] = choice(v, key, workPriorities);
    else if (key === "kind")
      out[key] = choice(v, key, ["ticket", "task", "incident", "follow_up"]);
    else if (key === "status" && update)
      out[key] = choice(v, key, workStatuses);
    else if (key === "due_at") out[key] = v === null ? null : timestamp(v, key);
    else if (
      ["first_response_minutes", "resolution_minutes"].includes(key) &&
      !update
    )
      out[key] = integer(v, key, 1, 525600);
    else if (key === "escalated") {
      if (typeof v !== "boolean") throw new InputError("Invalid escalation");
      out[key] = v;
    } else if (key === "record_response" && update) {
      if (v !== true) throw new InputError("Invalid response acknowledgement");
      out.first_responded_at = new Date().toISOString();
    } else throw new InputError(`Unknown or immutable field: ${key}`);
  }
  if (update && !out.version) throw new InputError("version required");
  if (!update && !out.name) throw new InputError("name required");
  return out;
}
export function workItemSla(item: WorkItem, now: string) {
  return evaluateTicketSla({
    policy: {
      targets: {
        firstResponseMinutes: item.first_response_minutes,
        resolutionMinutes: item.resolution_minutes,
      },
      warningFraction: item.warning_fraction,
    },
    priority: item.priority as WorkPriority,
    createdAt: item.created_at,
    now,
    firstRespondedAt: item.first_responded_at,
    resolvedAt: item.resolved_at,
  });
}

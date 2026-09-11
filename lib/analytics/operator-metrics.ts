import { object } from "@/lib/product/validation";
export interface OperatorMetrics {
  work_items: {
    total: number;
    backlog: number;
    unassigned: number;
    escalated: number;
    resolution_breached: number;
    resolution_warning: number;
    first_response_breached: number;
    response_samples: number;
    resolution_samples: number;
    average_response_seconds: number | null;
    average_resolution_seconds: number | null;
  };
  contacts: { total: number; created_last_30_days: number };
  companies: number;
  pipeline_by_currency: {
    currency: string;
    deals: number;
    value_minor: string;
  }[];
  conversation_projection: {
    total: number;
    open: number;
    snoozed: number;
    automation_paused: number;
  };
  flows: { total: number; published: number };
  sequences: { total: number; active: number };
  channels: { projected: number; active_projection: number };
  as_of: string;
}
export function parseOperatorMetrics(value: unknown): OperatorMetrics {
  const v = object(value);
  const fields: Record<string, string[]> = {
    work_items: [
      "total",
      "backlog",
      "unassigned",
      "escalated",
      "resolution_breached",
      "resolution_warning",
      "first_response_breached",
      "response_samples",
      "resolution_samples",
      "average_response_seconds",
      "average_resolution_seconds",
    ],
    contacts: ["total", "created_last_30_days"],
    conversation_projection: ["total", "open", "snoozed", "automation_paused"],
    flows: ["total", "published"],
    sequences: ["total", "active"],
    channels: ["projected", "active_projection"],
  };
  for (const [key, required] of Object.entries(fields)) {
    const section = object(v[key]);
    for (const field of required) {
      const n = section[field];
      if (n === null && field.startsWith("average_")) continue;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
        throw new Error("Invalid metrics response");
    }
  }
  if (
    typeof v.companies !== "number" ||
    !Number.isSafeInteger(v.companies) ||
    v.companies < 0 ||
    !Array.isArray(v.pipeline_by_currency) ||
    typeof v.as_of !== "string" ||
    !Number.isFinite(Date.parse(v.as_of))
  )
    throw new Error("Invalid metrics response");
  for (const row of v.pipeline_by_currency) {
    const r = object(row);
    if (
      typeof r.currency !== "string" ||
      typeof r.deals !== "number" ||
      typeof r.value_minor !== "string" ||
      !/^\d+$/.test(r.value_minor)
    )
      throw new Error("Invalid currency aggregate");
  }
  return v as unknown as OperatorMetrics;
}
export function durationLabel(seconds: number | null): string {
  return seconds === null
    ? "No recorded samples"
    : `${Math.round(seconds / 60)} minutes`;
}

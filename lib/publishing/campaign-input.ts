import { choice, InputError, integer, object, text, timestamp, uuid } from "@/lib/product/validation";
import type { Json } from "@/lib/types/database";
import { normalizeUtm } from "./utm";

export const CAMPAIGN_OBJECTIVES = ["awareness", "engagement", "lead_generation", "sales", "launch", "community", "other"] as const;
export const CAMPAIGN_STATUSES = ["draft", "planned", "active", "paused", "completed", "archived"] as const;

const STATUS_FLOW: Record<string, readonly string[]> = {
  draft: ["planned", "active", "archived"],
  planned: ["draft", "active", "archived"],
  active: ["paused", "completed", "archived"],
  paused: ["active", "completed", "archived"],
  completed: ["archived", "active"],
  archived: ["draft"],
};

export function statusTransitionAllowed(from: string, to: string): boolean {
  return from === to || (STATUS_FLOW[from]?.includes(to) ?? false);
}

function zone(value: unknown): string {
  const z = text(value, "timezone", 100, true);
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
  } catch {
    throw new InputError("Invalid timezone");
  }
  return z;
}

function jsonObject(value: unknown, name: string, maxBytes: number): Json {
  const o = object(value);
  if (JSON.stringify(o).length > maxBytes) throw new InputError(`${name} is too large`);
  return o as Json;
}

/** Parses campaign create/update input (browser-editable fields only; results are server-managed). */
export function parseCampaignInput(value: unknown, update = false) {
  const input = object(value);
  const out: Record<string, unknown> = {};
  const allowed = new Set([
    "name", "objective", "status", "owner_id", "audience", "channel_ids", "voice", "content_plan",
    "utm_defaults", "starts_at", "ends_at", "timezone", "requires_approval", "notes", "version",
  ]);
  for (const [key, v] of Object.entries(input)) {
    if (!allowed.has(key)) throw new InputError(`Unknown field: ${key}`);
    switch (key) {
      case "name": out.name = text(v, "name", 200, true); break;
      case "objective": out.objective = choice(v, "objective", CAMPAIGN_OBJECTIVES); break;
      case "status": out.status = choice(v, "status", CAMPAIGN_STATUSES); break;
      case "owner_id": out.owner_id = v === null || v === "" ? null : uuid(v, "owner_id"); break;
      case "audience": out.audience = jsonObject(v, "audience", 16000); break;
      case "content_plan": out.content_plan = jsonObject(v, "content_plan", 60000); break;
      case "channel_ids":
        if (!Array.isArray(v) || v.length > 50) throw new InputError("channel_ids must be an array of up to 50 ids");
        out.channel_ids = [...new Set(v.map((id) => uuid(id, "channel id")))];
        break;
      case "voice": out.voice = text(v, "voice", 20000); break;
      case "notes": out.notes = text(v, "notes", 20000); break;
      case "utm_defaults": {
        const utm = normalizeUtm(object(v));
        out.utm_defaults = Object.fromEntries(Object.entries(utm).map(([k, val]) => [k.replace(/^utm_/, ""), val]));
        break;
      }
      case "starts_at": out.starts_at = v === null || v === "" ? null : timestamp(v, "starts_at"); break;
      case "ends_at": out.ends_at = v === null || v === "" ? null : timestamp(v, "ends_at"); break;
      case "timezone": out.timezone = zone(v); break;
      case "requires_approval":
        if (typeof v !== "boolean") throw new InputError("requires_approval must be boolean");
        out.requires_approval = v;
        break;
      case "version":
        if (!update) throw new InputError("Unknown field: version");
        out.version = integer(v, "version", 1);
        break;
    }
  }
  if (!update && !out.name) throw new InputError("name required");
  if (update && !out.version) throw new InputError("version required");
  if (out.starts_at && out.ends_at && String(out.ends_at) <= String(out.starts_at)) throw new InputError("ends_at must be after starts_at");
  return out;
}

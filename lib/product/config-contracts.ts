import {
  InputError,
  object,
  text,
  integer,
  timestamp,
  choice,
  uuid,
} from "./validation";
import { emailIdentity } from "@/lib/email/contracts";
export const configResources = [
  "editorial_drafts",
  "editorial_variants",
  "knowledge_sources",
  "mailbox_identities",
] as const;
export type ConfigResource = (typeof configResources)[number];
export function configResource(value: string): value is ConfigResource {
  return configResources.includes(value as ConfigResource);
}
export function ownerConfiguration(resource: ConfigResource) {
  return resource === "knowledge_sources" || resource === "mailbox_identities";
}
export function parseConfiguration(
  resource: ConfigResource,
  value: unknown,
  update = false,
) {
  const input = object(value);
  const out: Record<string, string | number | boolean | string[] | Record<string, string> | null> = {};
  const fields: Record<ConfigResource, string[]> = {
    editorial_drafts: [
      "name",
      "body",
      "campaign",
      "state",
      "scheduled_at",
      "timezone",
      "campaign_id",
      "kind",
      "link_url",
      "utm",
      "asset_ids",
    ],
    editorial_variants: ["draft_id", "channel_id", "body", "media_refs"],
    knowledge_sources: ["name", "source_ref", "enabled"],
    mailbox_identities: ["name", "address", "gateway_account_ref"],
  };
  for (const [key, v] of Object.entries(input)) {
    if (key === "version" && update) {
      out.version = integer(v, key, 1);
      continue;
    }
    if (!fields[resource].includes(key))
      throw new InputError(`Unknown field: ${key}`);
    if (key === "enabled") {
      if (typeof v !== "boolean")
        throw new InputError("enabled must be boolean");
      out[key] = v;
    } else if (key === "campaign_id")
      out[key] = v === null || v === "" ? null : uuid(v, key);
    else if (key === "kind")
      out[key] = choice(v, key, ["post", "short_video", "story", "thread", "article", "reel", "carousel"]);
    else if (key === "link_url") {
      if (v === null || v === "") out[key] = null;
      else {
        const url = text(v, key, 2000, true);
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new InputError("link_url must be a valid URL");
        }
        if (!["http:", "https:"].includes(parsed.protocol)) throw new InputError("link_url must use http or https");
        out[key] = parsed.toString();
      }
    } else if (key === "utm") {
      const utm = object(v);
      const clean: Record<string, string> = {};
      for (const [k, val] of Object.entries(utm)) {
        if (!["source", "medium", "campaign", "term", "content"].includes(k)) throw new InputError(`Unknown UTM field: ${k}`);
        if (val === null || val === "") continue;
        clean[k] = text(val, `utm ${k}`, 200);
      }
      out[key] = clean;
    } else if (key === "asset_ids") {
      if (!Array.isArray(v) || v.length > 20) throw new InputError("Maximum 20 assets");
      out[key] = [...new Set(v.map((i) => uuid(i, "asset id")))];
    } else if (key === "state")
      out[key] = choice(v, key, ["draft", "in_review", "approved"]);
    else if (key === "address")
      out[key] = emailIdentity({ address: v }).address;
    else if (key === "scheduled_at")
      out[key] = v === null ? null : timestamp(v, key);
    else if (key.endsWith("_id")) out[key] = uuid(v, key);
    else if (key === "media_refs") {
      if (!Array.isArray(v) || v.length > 20)
        throw new InputError("Maximum 20 media references");
      out[key] = v.map((i) => text(i, "media reference", 500, true));
    } else if (key === "timezone") {
      const zone = text(v, key, 100, true);
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
      } catch {
        throw new InputError("Invalid timezone");
      }
      out[key] = zone;
    } else
      out[key] = text(
        v,
        key,
        key === "body" ? 100000 : key.endsWith("_ref") ? 500 : 200,
        ["name", "source_ref"].includes(key),
      );
  }
  if (update && !out.version) throw new InputError("version required");
  if (!update) {
    const required =
      resource === "editorial_variants"
        ? ["draft_id", "channel_id", "body"]
        : resource === "knowledge_sources"
          ? ["name", "source_ref"]
          : resource === "mailbox_identities"
            ? ["name", "address"]
            : ["name"];
    for (const key of required)
      if (!out[key]) throw new InputError(`${key} required`);
  }
  return out;
}

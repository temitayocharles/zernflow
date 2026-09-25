import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ServiceClient } from "@/lib/tasks/types";
import { InputError, object, text } from "@/lib/product/validation";
import { normalizeUtm, type UtmParams } from "@/lib/publishing/utm";
import { recordAudit } from "@/lib/audit";
import { recordTouchpoint, resolveCampaignFromUtm } from "./service";

/** Lead intake tokens: `zfl_` + 32 random bytes (base64url). Only the SHA-256 is stored. */
export function generateIntakeToken(): { token: string; hash: string } {
  const token = `zfl_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashIntakeToken(token) };
}

export function hashIntakeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bearerIntakeToken(header: string | null): string | null {
  const match = /^Bearer\s+(zfl_[A-Za-z0-9_-]{40,60})$/.exec(header?.trim() ?? "");
  return match ? match[1] : null;
}

export interface IntakeToken {
  id: string;
  workspace_id: string;
  default_campaign_id: string | null;
}

export async function authenticateIntake(service: ServiceClient, header: string | null): Promise<IntakeToken | null> {
  const token = bearerIntakeToken(header);
  if (!token) return null;
  const hash = hashIntakeToken(token);
  const { data } = await service
    .from("lead_intake_tokens")
    .select("id, workspace_id, default_campaign_id, token_hash, revoked_at")
    .eq("token_hash", hash)
    .maybeSingle();
  const row = data as (IntakeToken & { token_hash: string; revoked_at: string | null }) | null;
  if (!row || row.revoked_at) return null;
  // Defence in depth against lookup quirks: compare hashes in constant time.
  if (!timingSafeEqual(Buffer.from(row.token_hash, "hex"), Buffer.from(hash, "hex"))) return null;
  return { id: row.id, workspace_id: row.workspace_id, default_campaign_id: row.default_campaign_id };
}

export interface LeadInput {
  email: string;
  name: string | null;
  utm: UtmParams;
  landingUrl: string | null;
  note: string;
  idempotencyKey: string | null;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

export function parseLead(raw: unknown, idempotencyKey: string | null): LeadInput {
  const body = object(raw);
  const email = text(body.email, "email", 254, true).toLowerCase();
  if (!EMAIL.test(email)) throw new InputError("A valid email is required");
  const name = body.name === undefined || body.name === null || body.name === "" ? null : text(body.name, "name", 200);
  let landingUrl: string | null = null;
  if (typeof body.landingUrl === "string" && body.landingUrl) {
    try {
      const u = new URL(body.landingUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      landingUrl = u.toString().slice(0, 2000);
    } catch {
      throw new InputError("landingUrl must be an http(s) URL");
    }
  }
  // UTM may arrive as an object or be read from the landing URL's query string.
  const fromUrl = landingUrl ? Object.fromEntries(new URL(landingUrl).searchParams) : {};
  const utm = { ...normalizeUtm(fromUrl), ...normalizeUtm(body.utm) };
  const note = body.note === undefined ? "" : text(body.note, "note", 1000);
  const key = idempotencyKey?.trim();
  if (key && !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) throw new InputError("Idempotency-Key must be 1-120 URL-safe characters");
  return { email, name, utm, landingUrl, note, idempotencyKey: key || null };
}

function escapeLike(v: string) {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Finds (case-insensitively) or creates the contact, then records a `form` touchpoint. */
export async function intakeLead(service: ServiceClient, token: IntakeToken, lead: LeadInput): Promise<{ contactId: string; created: boolean; campaignId: string | null; duplicate: boolean }> {
  const ws = token.workspace_id;
  const { data: existing } = await service.from("contacts").select("id").eq("workspace_id", ws).ilike("email", escapeLike(lead.email)).limit(1).maybeSingle();
  let contactId = (existing as { id: string } | null)?.id ?? null;
  let created = false;
  if (!contactId) {
    const { data, error } = await service
      .from("contacts")
      .insert({ workspace_id: ws, email: lead.email, display_name: lead.name ?? lead.email.split("@")[0], metadata: { created_via: "lead_intake" } } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`contact insert failed: ${error?.code ?? "unknown"}`);
    contactId = (data as { id: string }).id;
    created = true;
    await recordAudit(service, { workspaceId: ws, entityType: "contacts", entityId: contactId, actorId: null, action: "contact.created_via_intake", changes: { intake_token: token.id } });
  }
  const campaignId = token.default_campaign_id ?? (await resolveCampaignFromUtm(service, ws, lead.utm));
  const { created: touch } = await recordTouchpoint(service, {
    workspaceId: ws,
    contactId,
    source: "form",
    campaignId,
    utm: lead.utm,
    landingUrl: lead.landingUrl,
    note: lead.note,
    dedupeKey: lead.idempotencyKey ? `intake:${token.id}:${lead.idempotencyKey}` : null,
  });
  await service.from("lead_intake_tokens").update({ last_used_at: new Date().toISOString() } as never).eq("id", token.id);
  return { contactId, created, campaignId, duplicate: !touch };
}

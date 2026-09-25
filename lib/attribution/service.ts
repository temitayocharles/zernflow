import "server-only";
import type { ServiceClient } from "@/lib/tasks/types";
import { normalizeUtm, slugify, type UtmParams } from "@/lib/publishing/utm";

export type TouchpointSource = "comment" | "dm" | "form" | "link" | "manual" | "import";

export interface TouchpointInput {
  workspaceId: string;
  contactId: string;
  source: TouchpointSource;
  campaignId?: string | null;
  variantId?: string | null;
  channelId?: string | null;
  utm?: UtmParams;
  externalRef?: string | null;
  landingUrl?: string | null;
  note?: string;
  dedupeKey?: string | null;
  occurredAt?: string;
  createdBy?: string | null;
}

export const TOUCHPOINT_COLUMNS = "id, workspace_id, contact_id, campaign_id, variant_id, channel_id, source, utm, external_ref, landing_url, note, occurred_at, created_by, created_at";

/** Inserts a touchpoint; a repeated dedupe key is a no-op (`created: false`). */
export async function recordTouchpoint(service: ServiceClient, t: TouchpointInput): Promise<{ created: boolean }> {
  const { error } = await service.from("contact_touchpoints").insert({
    workspace_id: t.workspaceId,
    contact_id: t.contactId,
    source: t.source,
    campaign_id: t.campaignId ?? null,
    variant_id: t.variantId ?? null,
    channel_id: t.channelId ?? null,
    utm: t.utm ?? {},
    external_ref: t.externalRef?.slice(0, 300) ?? null,
    landing_url: t.landingUrl ?? null,
    note: (t.note ?? "").slice(0, 1000),
    dedupe_key: t.dedupeKey?.slice(0, 200) ?? null,
    occurred_at: t.occurredAt ?? new Date().toISOString(),
    created_by: t.createdBy ?? null,
  } as never);
  if (!error) return { created: true };
  if (error.code === "23505") return { created: false };
  throw new Error(`touchpoint insert failed: ${error.code ?? "unknown"}`);
}

/** Published variant (and its campaign) for a provider post on a channel. */
export async function campaignForPost(
  service: ServiceClient,
  input: { workspaceId: string; channelId: string; postId: string },
): Promise<{ campaignId: string | null; variantId: string } | null> {
  const { data: variant } = await service
    .from("editorial_variants")
    .select("id, draft_id")
    .eq("workspace_id", input.workspaceId)
    .eq("channel_id", input.channelId)
    .eq("external_ref", input.postId)
    .limit(1)
    .maybeSingle();
  if (!variant) return null;
  const v = variant as { id: string; draft_id: string };
  const { data: draft } = await service.from("editorial_drafts").select("campaign_id").eq("workspace_id", input.workspaceId).eq("id", v.draft_id).maybeSingle();
  return { variantId: v.id, campaignId: (draft as { campaign_id: string | null } | null)?.campaign_id ?? null };
}

/**
 * Matches `utm_campaign` to a campaign: explicit `utm_defaults.utm_campaign`
 * first, then the slug of the campaign name (what tracked links use by default).
 */
export async function resolveCampaignFromUtm(service: ServiceClient, workspaceId: string, utm: UtmParams): Promise<string | null> {
  const wanted = utm.utm_campaign?.trim().toLowerCase();
  if (!wanted) return null;
  const { data } = await service
    .from("campaigns")
    .select("id, name, utm_defaults, status")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(500);
  const rows = (data ?? []) as { id: string; name: string; utm_defaults: unknown; status: string }[];
  const explicit = rows.find((c) => normalizeUtm(c.utm_defaults).utm_campaign?.toLowerCase() === wanted);
  if (explicit) return explicit.id;
  return rows.find((c) => slugify(c.name) === wanted)?.id ?? null;
}

/**
 * Attributes a commenter to the campaign whose published post they commented on.
 * Best-effort: attribution never blocks comment automation.
 */
export async function recordCommentTouchpoint(
  service: ServiceClient,
  input: { workspaceId: string; channelId: string; contactId: string; postId: string; commentId: string; platform: string },
): Promise<void> {
  try {
    const post = await campaignForPost(service, input);
    await recordTouchpoint(service, {
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      source: "comment",
      campaignId: post?.campaignId ?? null,
      variantId: post?.variantId ?? null,
      channelId: input.channelId,
      utm: { utm_source: input.platform, utm_medium: "social" },
      externalRef: input.postId,
      dedupeKey: `comment:${input.channelId}:${input.commentId}`,
    });
  } catch {
    /* attribution is advisory */
  }
}

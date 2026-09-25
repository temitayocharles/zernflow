import { ApiError, databaseError, failure, json, productContext, readJson } from "@/lib/product/api";
import { object, text, uuid } from "@/lib/product/validation";
import { TOUCHPOINT_COLUMNS } from "@/lib/attribution/service";

/** GET → the contact's touchpoints (members; RLS-scoped). */
export async function GET(_request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    const contactId = uuid((await params).contactId, "contact id");
    const { supabase, workspaceId } = await productContext();
    const { data, error } = await supabase.from("contact_touchpoints").select(TOUCHPOINT_COLUMNS).eq("workspace_id", workspaceId).eq("contact_id", contactId).order("occurred_at", { ascending: false }).limit(100);
    databaseError(error);
    return json({ touchpoints: data ?? [] });
  } catch (error) {
    return failure(error);
  }
}

/** POST { campaignId?, note?, occurredAt? } → a manual touchpoint recorded as the caller (RLS enforces it). */
export async function POST(request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    const contactId = uuid((await params).contactId, "contact id");
    const { supabase, workspaceId, user } = await productContext();
    const body = object(await readJson(request, 2048));
    const campaignId = body.campaignId ? uuid(body.campaignId, "campaign") : null;
    const note = body.note === undefined ? "" : text(body.note, "note", 1000);
    let occurredAt = new Date().toISOString();
    if (typeof body.occurredAt === "string" && body.occurredAt) {
      const d = new Date(body.occurredAt);
      if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 60_000) throw new ApiError(400, "occurredAt must be a past date");
      occurredAt = d.toISOString();
    }
    const { data: contact } = await supabase.from("contacts").select("id").eq("workspace_id", workspaceId).eq("id", contactId).maybeSingle();
    if (!contact) throw new ApiError(404, "Contact not found");
    const { data, error } = await supabase
      .from("contact_touchpoints")
      .insert({ workspace_id: workspaceId, contact_id: contactId, campaign_id: campaignId, source: "manual", note, occurred_at: occurredAt, created_by: user.id })
      .select(TOUCHPOINT_COLUMNS)
      .single();
    databaseError(error);
    return json({ touchpoint: data }, 201);
  } catch (error) {
    return failure(error);
  }
}

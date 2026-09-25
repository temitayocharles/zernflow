import { ApiError, databaseError, json, productContext, readJson } from "@/lib/product/api";
import { object, text, uuid } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { generateIntakeToken } from "@/lib/attribution/intake";
import { recordAudit } from "@/lib/audit";
import { failure } from "@/lib/product/api";

const COLUMNS = "id, name, default_campaign_id, created_at, last_used_at, revoked_at";

function requireOwner(role: string) {
  if (role !== "owner") throw new ApiError(403, "Only workspace owners can manage lead intake");
}

export async function GET() {
  try {
    const { supabase, workspaceId, role } = await productContext();
    requireOwner(role);
    const { data, error } = await supabase.from("lead_intake_tokens").select(COLUMNS).eq("workspace_id", workspaceId).order("created_at", { ascending: false });
    databaseError(error);
    return json({ tokens: data ?? [] });
  } catch (error) {
    return failure(error);
  }
}

/** POST { name, defaultCampaignId? } → the plaintext token, shown exactly once. */
export async function POST(request: Request) {
  try {
    const { supabase, workspaceId, role, user } = await productContext();
    requireOwner(role);
    const body = object(await readJson(request, 2048));
    const name = text(body.name, "name", 120, true);
    let defaultCampaignId: string | null = null;
    if (body.defaultCampaignId) {
      defaultCampaignId = uuid(body.defaultCampaignId, "campaign");
      const { data } = await supabase.from("campaigns").select("id").eq("workspace_id", workspaceId).eq("id", defaultCampaignId).maybeSingle();
      if (!data) throw new ApiError(400, "Campaign not found");
    }
    const { token, hash } = generateIntakeToken();
    const service = await createServiceClient();
    const { data, error } = await service
      .from("lead_intake_tokens")
      .insert({ workspace_id: workspaceId, name, token_hash: hash, default_campaign_id: defaultCampaignId, created_by: user.id })
      .select(COLUMNS)
      .single();
    databaseError(error);
    await recordAudit(service, { workspaceId, entityType: "lead_intake_tokens", entityId: (data as { id: string }).id, actorId: user.id, action: "lead_intake.token_created", changes: { name: true, default_campaign_id: Boolean(defaultCampaignId) } });
    return json({ token, record: data }, 201);
  } catch (error) {
    return failure(error);
  }
}

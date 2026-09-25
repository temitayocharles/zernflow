import { ApiError, failure, json, productContext } from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";

export async function POST(_request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  try {
    const tokenId = uuid((await params).tokenId, "token id");
    const { supabase, workspaceId, role, user } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Only workspace owners can manage lead intake");
    const { data } = await supabase.from("lead_intake_tokens").select("id, revoked_at").eq("workspace_id", workspaceId).eq("id", tokenId).maybeSingle();
    if (!data) throw new ApiError(404, "Token not found");
    if (!(data as { revoked_at: string | null }).revoked_at) {
      const service = await createServiceClient();
      await service.from("lead_intake_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", tokenId).eq("workspace_id", workspaceId);
      await recordAudit(service, { workspaceId, entityType: "lead_intake_tokens", entityId: tokenId, actorId: user.id, action: "lead_intake.token_revoked" });
    }
    return json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}

import { ApiError, databaseError, failure, json, productContext } from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";

/** DELETE revokes a worker token immediately; its running leases expire and are recovered. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ workerId: string }> }) {
  try {
    const id = uuid((await params).workerId, "worker id");
    const { workspaceId, role, user } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Workspace owner access required");
    const service = await createServiceClient();
    const { data, error } = await service
      .from("worker_identities")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();
    databaseError(error);
    if (!data) throw new ApiError(404, "Active worker not found");
    await recordAudit(service, {
      workspaceId,
      entityType: "worker_identity",
      entityId: id,
      actorId: user.id,
      action: "worker.token_revoked",
    });
    return json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}

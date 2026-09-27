import { ApiError, json, productContext } from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { getObjectStore } from "@/lib/storage";
import { ARTIFACT_COLUMNS, deleteArtifact, signedDownload } from "@/lib/artifacts/service";
import { artifactFailure } from "@/lib/artifacts/http";

type Params = { params: Promise<{ assetId: string }> };

/** GET → metadata and, when available, a short-lived signed download URL (members). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const id = uuid((await params).assetId, "asset id");
    const { supabase, workspaceId } = await productContext();
    // Membership + tenant check through RLS before any service-role access.
    const { data: visible } = await supabase.from("artifacts").select(ARTIFACT_COLUMNS).eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    if (!visible) throw new ApiError(404, "Asset not found");
    if (visible.status !== "available") return json({ asset: visible, download: null });
    const service = await createServiceClient();
    const { url, expiresAt } = await signedDownload(service, getObjectStore(), { workspaceId, artifactId: id });
    return json({ asset: visible, download: { url, expiresAt } });
  } catch (error) {
    return artifactFailure(error);
  }
}

/** DELETE → removes the object and tombstones the row. Owners, or the member who uploaded it. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const id = uuid((await params).assetId, "asset id");
    const { supabase, workspaceId, role, user } = await productContext();
    const { data: visible } = await supabase.from("artifacts").select("id, created_by").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    if (!visible) throw new ApiError(404, "Asset not found");
    if (role !== "owner" && visible.created_by !== user.id) throw new ApiError(403, "Only owners or the uploader can delete this asset");
    const service = await createServiceClient();
    await deleteArtifact(service, getObjectStore(), { workspaceId, artifactId: id, actor: { type: "user", id: user.id } });
    return json({ ok: true });
  } catch (error) {
    return artifactFailure(error);
  }
}

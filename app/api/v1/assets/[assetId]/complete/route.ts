import { ApiError, json, productContext } from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { getObjectStore } from "@/lib/storage";
import { completeUpload } from "@/lib/artifacts/service";
import { artifactFailure } from "@/lib/artifacts/http";

/** POST → verifies the uploaded bytes (size/type/checksum/signature) → available | quarantined. */
export async function POST(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const id = uuid((await params).assetId, "asset id");
    const { supabase, workspaceId, user } = await productContext();
    const { data: visible } = await supabase.from("artifacts").select("id").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    if (!visible) throw new ApiError(404, "Asset not found");
    const service = await createServiceClient();
    const asset = await completeUpload(service, getObjectStore(), { workspaceId, artifactId: id, actor: { type: "user", id: user.id } });
    return json({ asset }, asset.status === "available" ? 200 : 422);
  } catch (error) {
    return artifactFailure(error);
  }
}

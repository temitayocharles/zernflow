import { NextResponse } from "next/server";
import { ApiError, productContext } from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { getObjectStore } from "@/lib/storage";
import { signedDownload } from "@/lib/artifacts/service";
import { artifactFailure } from "@/lib/artifacts/http";

/** GET → 302 to a 60-second signed URL (members; tenant-checked through RLS first). */
export async function GET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const id = uuid((await params).assetId, "asset id");
    const { supabase, workspaceId } = await productContext();
    const { data: visible } = await supabase.from("artifacts").select("id").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    if (!visible) throw new ApiError(404, "Asset not found");
    const service = await createServiceClient();
    const { url } = await signedDownload(service, getObjectStore(), { workspaceId, artifactId: id, expiresInSeconds: 60 });
    return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) {
    return artifactFailure(error);
  }
}

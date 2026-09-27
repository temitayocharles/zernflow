import { databaseError, json, productContext, readJson } from "@/lib/product/api";
import { choice, integer, object, text, uuid } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { getObjectStore, objectStoreConfigured } from "@/lib/storage";
import { readBudget } from "@/lib/runtime/budget";
import { ARTIFACT_COLUMNS, createUpload } from "@/lib/artifacts/service";
import { ALL_KINDS, USER_UPLOAD_KINDS } from "@/lib/artifacts/policy";
import { artifactFailure } from "@/lib/artifacts/http";
import type { ArtifactKind } from "@/lib/types/platform";

const PAGE = 50;

/** GET ?kind=&page= → workspace assets (RLS: members). */
export async function GET(request: Request) {
  try {
    const { supabase, workspaceId } = await productContext();
    const url = new URL(request.url);
    const page = Math.max(1, Math.min(1000, Number(url.searchParams.get("page")) || 1));
    const kind = url.searchParams.get("kind");
    let query = supabase
      .from("artifacts")
      .select(ARTIFACT_COLUMNS, { count: "exact" })
      .eq("workspace_id", workspaceId)
      .neq("status", "deleted")
      .order("created_at", { ascending: false })
      .range((page - 1) * PAGE, page * PAGE - 1);
    if (kind) query = query.eq("kind", choice(kind, "kind", ALL_KINDS) as ArtifactKind);
    const { data, error, count } = await query;
    databaseError(error);
    return json({ assets: data ?? [], total: count ?? 0, page, storageConfigured: objectStoreConfigured() });
  } catch (error) {
    return artifactFailure(error);
  }
}

/** POST { fileName, contentType, sizeBytes, sha256, kind, campaignId? } → presigned PUT (members). */
export async function POST(request: Request) {
  try {
    const { workspaceId, user } = await productContext();
    const body = object(await readJson(request, 8192));
    const service = await createServiceClient();
    const budget = readBudget();
    const result = await createUpload(service, getObjectStore(), budget, {
      workspaceId,
      kind: choice(body.kind ?? "image", "kind", ALL_KINDS) as ArtifactKind,
      allowedKinds: USER_UPLOAD_KINDS,
      fileName: text(body.fileName, "fileName", 255, true),
      contentType: text(body.contentType, "contentType", 100, true),
      sizeBytes: integer(body.sizeBytes, "sizeBytes", 1, Number.MAX_SAFE_INTEGER),
      sha256: text(body.sha256, "sha256", 64, true),
      campaignId: body.campaignId ? uuid(body.campaignId, "campaignId") : null,
      actor: { type: "user", id: user.id },
    });
    return json(result, 201);
  } catch (error) {
    return artifactFailure(error);
  }
}

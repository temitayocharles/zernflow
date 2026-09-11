import {
  ApiError,
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
import { object, text, uuid, integer } from "@/lib/product/validation";
import { HttpKnowledgeClient } from "@/lib/knowledge/client";
export async function POST(request: Request) {
  try {
    const { supabase, workspaceId } = await productContext();
    const input = object(await request.json());
    const query = text(input.query, "query", 4000, true);
    if (
      !Array.isArray(input.sourceIds) ||
      input.sourceIds.length < 1 ||
      input.sourceIds.length > 20
    )
      throw new ApiError(400, "Choose 1–20 enabled sources");
    const ids = [...new Set(input.sourceIds.map((v) => uuid(v, "source")))];
    const limit = integer(input.limit ?? 5, "limit", 1, 20);
    const { data, error } = await supabase
      .from("knowledge_sources")
      .select("id,source_ref")
      .eq("workspace_id", workspaceId)
      .eq("enabled", true)
      .in("id", ids);
    databaseError(error);
    if (data?.length !== ids.length)
      throw new ApiError(403, "One or more sources are unavailable");
    const endpoint = process.env.KNOWLEDGE_RETRIEVAL_URL,
      token = process.env.KNOWLEDGE_API_TOKEN;
    if (!endpoint || !token)
      throw new ApiError(503, "External knowledge retrieval is not configured");
    try {
      const result = await new HttpKnowledgeClient(endpoint, token).retrieve({
        workspaceRef: workspaceId,
        query,
        sourceRefs: data.map((s) => s.source_ref),
        limit,
      });
      return json(result);
    } catch {
      throw new ApiError(
        502,
        "Knowledge retrieval failed. No answer context is available.",
      );
    }
  } catch (e) {
    return failure(e);
  }
}

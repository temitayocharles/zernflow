import { readJson } from "@/lib/product/api";
import {
  ApiError,
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
import { parseBulkWorkChanges } from "@/lib/service-desk/bulk";
export async function POST(request: Request) {
  try {
    const { supabase, workspaceId } = await productContext();
    const changes = parseBulkWorkChanges(await readJson(request));
    const { data, error } = await supabase.rpc("bulk_update_work_items", {
      p_workspace_id: workspaceId,
      p_changes: changes,
    });
    if (error?.code === "P0002")
      throw new ApiError(
        409,
        "One or more items changed or are unavailable. Nothing was updated; reload before retrying.",
      );
    databaseError(error);
    return json({ updated: data });
  } catch (e) {
    return failure(e);
  }
}

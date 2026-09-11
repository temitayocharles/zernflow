import {
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
export async function GET() {
  try {
    const { supabase, workspaceId } = await productContext();
    const { data, error } = await supabase.rpc("workspace_operator_directory", {
      p_workspace_id: workspaceId,
    });
    databaseError(error);
    return json({ members: data, limit: 500 });
  } catch (e) {
    return failure(e);
  }
}

import { failure, json, productContext, databaseError } from "@/lib/product/api";
import { CHANNEL_SAFE_COLUMNS } from "@/lib/workspace";

export async function GET() {
  try {
    const { supabase, workspaceId } = await productContext();
    const { data: channels, error } = await supabase
      .from("channels")
      .select(CHANNEL_SAFE_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    databaseError(error);
    return json(channels ?? []);
  } catch (error) {
    return failure(error);
  }
}

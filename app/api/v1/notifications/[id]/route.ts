import {
  ApiError,
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";
export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = uuid((await params).id, "notification");
    const { supabase, workspaceId, user } = await productContext();
    const { data, error } = await supabase
      .from("operator_notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("recipient_id", user.id)
      .eq("id", id)
      .select()
      .maybeSingle();
    databaseError(error);
    if (!data) throw new ApiError(404, "Notification not found");
    return json(data);
  } catch (e) {
    return failure(e);
  }
}

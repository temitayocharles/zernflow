import {
  ApiError,
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
import { object, text, uuid, integer } from "@/lib/product/validation";
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = uuid((await params).id, "id");
    const { supabase, workspaceId } = await productContext();
    const input = object(await request.json());
    const name = text(input.name, "name", 200, true),
      description = text(input.description ?? "", "description", 10000),
      version = integer(input.version, "version", 1);
    const { data, error } = await supabase
      .from("work_queues")
      .update({ name, description })
      .eq("workspace_id", workspaceId)
      .eq("id", id)
      .eq("version", version)
      .select()
      .maybeSingle();
    databaseError(error);
    if (!data)
      throw new ApiError(
        409,
        "Queue changed or is unavailable. Reload before editing.",
      );
    return json(data);
  } catch (e) {
    return failure(e);
  }
}

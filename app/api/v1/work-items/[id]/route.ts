import {
  ApiError,
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
import { parseWorkInput, workItemSla } from "@/lib/service-desk/work-items";
import { uuid } from "@/lib/product/validation";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context) {
  try {
    const id = uuid((await params).id, "id");
    const { supabase, workspaceId } = await productContext();
    const { data, error } = await supabase
      .from("work_items")
      .select()
      .eq("workspace_id", workspaceId)
      .eq("id", id)
      .maybeSingle();
    databaseError(error);
    if (!data) throw new ApiError(404, "Work item not found");
    return json({ ...data, sla: workItemSla(data, new Date().toISOString()) });
  } catch (e) {
    return failure(e);
  }
}
export async function PATCH(request: Request, { params }: Context) {
  try {
    const id = uuid((await params).id, "id");
    const { supabase, workspaceId } = await productContext();
    const { version, ...input } = parseWorkInput(await request.json(), true);
    const { data, error } = await supabase
      .from("work_items")
      .update(input)
      .eq("workspace_id", workspaceId)
      .eq("id", id)
      .eq("version", version as number)
      .select()
      .maybeSingle();
    databaseError(error);
    if (!data)
      throw new ApiError(
        409,
        "Work item changed or is unavailable. Reload before editing.",
      );
    return json(data);
  } catch (e) {
    return failure(e);
  }
}

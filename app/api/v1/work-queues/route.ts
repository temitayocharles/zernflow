import {
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
import { object, text } from "@/lib/product/validation";
export async function POST(request: Request) {
  try {
    const { supabase, workspaceId } = await productContext();
    const input = object(await request.json());
    const name = text(input.name, "name", 200, true);
    const { data, error } = await supabase
      .from("work_queues")
      .insert({ workspace_id: workspaceId, name })
      .select()
      .single();
    databaseError(error);
    return json(data, 201);
  } catch (e) {
    return failure(e);
  }
}

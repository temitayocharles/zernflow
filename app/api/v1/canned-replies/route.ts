import {
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
import { object, text } from "@/lib/product/validation";
export async function GET() {
  try {
    const { supabase, workspaceId } = await productContext();
    const { data, error } = await supabase
      .from("canned_replies")
      .select()
      .eq("workspace_id", workspaceId)
      .order("name")
      .limit(200);
    databaseError(error);
    return json({ items: data });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    const { supabase, workspaceId } = await productContext();
    const input = object(await request.json());
    const { data, error } = await supabase
      .from("canned_replies")
      .insert({
        workspace_id: workspaceId,
        name: text(input.name, "name", 200, true),
        body: text(input.body, "body", 10000, true),
      })
      .select()
      .single();
    databaseError(error);
    return json(data, 201);
  } catch (e) {
    return failure(e);
  }
}

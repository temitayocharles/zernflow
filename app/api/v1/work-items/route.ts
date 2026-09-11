import {
  ApiError,
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
import {
  parseWorkInput,
  workPriorities,
  workStatuses,
} from "@/lib/service-desk/work-items";
import { choice, uuid } from "@/lib/product/validation";
import type { Database } from "@/lib/types/database";
export async function GET(request: Request) {
  try {
    const { supabase, workspaceId } = await productContext();
    const params = new URL(request.url).searchParams;
    const page = Math.max(0, Math.floor(Number(params.get("page")) || 0));
    if (page > 10000) throw new ApiError(400, "Page out of range");
    let query = supabase
      .from("work_items")
      .select("*", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .order("id")
      .range(page * 50, page * 50 + 49);
    for (const field of [
      "status",
      "priority",
      "queue_id",
      "assignee_id",
      "contact_id",
      "conversation_id",
    ] as const) {
      const v = params.get(field);
      if (v)
        query = query.eq(
          field,
          field.endsWith("_id")
            ? uuid(v, field)
            : choice(
                v,
                field,
                field === "status" ? workStatuses : workPriorities,
              ),
        );
    }
    const q = params.get("q");
    if (q)
      query = query.ilike(
        "name",
        `%${q.slice(0, 100).replace(/[%_\\]/g, "\\$&")}%`,
      );
    const { data, error, count } = await query;
    databaseError(error);
    return json({ items: data, total: count, page });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    const { supabase, workspaceId } = await productContext();
    const input = parseWorkInput(await request.json());
    const { data, error } = await supabase
      .from("work_items")
      .insert({
        ...input,
        workspace_id: workspaceId,
      } as Database["public"]["Tables"]["work_items"]["Insert"])
      .select()
      .single();
    databaseError(error);
    return json(data, 201);
  } catch (e) {
    return failure(e);
  }
}

import { isCrmResource, parseCrmInput } from "@/lib/crm/contracts";
import {
  ApiError,
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
import type { Database } from "@/lib/types/database";
type Context = { params: Promise<{ resource: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    const { resource } = await params;
    if (!isCrmResource(resource))
      throw new ApiError(404, "Unknown CRM resource");
    const { supabase, workspaceId } = await productContext();
    const url = new URL(request.url);
    const page = Math.max(
      0,
      Math.min(10000, Math.floor(Number(url.searchParams.get("page")) || 0)),
    );
    let query = supabase
      .from(resource)
      .select("*", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .order("id")
      .range(page * 50, page * 50 + 49);
    const search = url.searchParams.get("q")?.trim();
    if (search && resource !== "customer_profiles")
      query = query.ilike(
        "name",
        `%${search.slice(0, 100).replace(/[%_\\]/g, "\\$&")}%`,
      );
    const { data, error, count } = await query;
    databaseError(error);
    return json({ items: data, total: count, page });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request, { params }: Context) {
  try {
    const { resource } = await params;
    if (!isCrmResource(resource))
      throw new ApiError(404, "Unknown CRM resource");
    const { supabase, workspaceId } = await productContext();
    const input = parseCrmInput(resource, await request.json());
    const row = {
      ...input,
      workspace_id: workspaceId,
    } as Database["public"]["Tables"][typeof resource]["Insert"];
    const { data, error } = await supabase
      .from(resource)
      .insert(row)
      .select()
      .single();
    databaseError(error);
    return json(data, 201);
  } catch (error) {
    return failure(error);
  }
}

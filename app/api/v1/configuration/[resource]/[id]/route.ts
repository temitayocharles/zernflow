import {
  ApiError,
  databaseError,
  failure,
  json,
  productContext,
} from "@/lib/product/api";
import {
  configResource,
  ownerConfiguration,
  parseConfiguration,
} from "@/lib/product/config-contracts";
import { uuid } from "@/lib/product/validation";
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ resource: string; id: string }> },
) {
  try {
    const { resource, id } = await params;
    if (!configResource(resource)) throw new ApiError(404, "Unknown resource");
    uuid(id, "id");
    const { supabase, workspaceId, role } = await productContext();
    if (ownerConfiguration(resource) && role !== "owner")
      throw new ApiError(403, "Workspace owner required");
    const { version, ...input } = parseConfiguration(
      resource,
      await request.json(),
      true,
    );
    const { data, error } = await supabase
      .from(resource)
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
        "Record changed or is unavailable. Reload before editing.",
      );
    return json(data);
  } catch (e) {
    return failure(e);
  }
}

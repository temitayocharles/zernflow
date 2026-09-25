import { ApiError, databaseError, json, productContext, readJson, failure } from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";
import { parseCampaignInput, statusTransitionAllowed } from "@/lib/publishing/campaign-input";
import type { Database } from "@/lib/types/database";

type Params = { params: Promise<{ campaignId: string }> };

export async function GET(_request: Request, { params }: Params) {
  try {
    const id = uuid((await params).campaignId, "campaign id");
    const { supabase, workspaceId } = await productContext();
    const { data, error } = await supabase.from("campaigns").select("*").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    databaseError(error);
    if (!data) throw new ApiError(404, "Campaign not found");
    return json({ campaign: data });
  } catch (error) {
    return failure(error);
  }
}

/** PATCH { version, ...fields } — optimistic concurrency; archiving is owner-only. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const id = uuid((await params).campaignId, "campaign id");
    const { supabase, workspaceId, role } = await productContext();
    const { version, ...input } = parseCampaignInput(await readJson(request, 128 * 1024), true);
    const { data: current } = await supabase.from("campaigns").select("status, version").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    if (!current) throw new ApiError(404, "Campaign not found");
    if (input.status && !statusTransitionAllowed(current.status, String(input.status))) {
      throw new ApiError(409, `Cannot move a ${current.status} campaign to ${input.status}`);
    }
    if (input.status === "archived" && role !== "owner") throw new ApiError(403, "Only owners can archive campaigns");
    const { data, error } = await supabase
      .from("campaigns")
      .update(input as Database["public"]["Tables"]["campaigns"]["Update"])
      .eq("workspace_id", workspaceId)
      .eq("id", id)
      .eq("version", Number(version))
      .select()
      .maybeSingle();
    databaseError(error);
    if (!data) throw new ApiError(409, "Campaign changed since you loaded it; reload and try again");
    return json({ campaign: data });
  } catch (error) {
    return failure(error);
  }
}

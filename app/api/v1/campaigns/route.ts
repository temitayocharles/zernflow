import { databaseError, json, productContext, readJson, failure } from "@/lib/product/api";
import { choice } from "@/lib/product/validation";
import { CAMPAIGN_STATUSES, parseCampaignInput } from "@/lib/publishing/campaign-input";
import type { Database } from "@/lib/types/database";

/** GET ?status= → campaigns (RLS: members). */
export async function GET(request: Request) {
  try {
    const { supabase, workspaceId } = await productContext();
    const status = new URL(request.url).searchParams.get("status");
    let q = supabase.from("campaigns").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(200);
    if (status) q = q.eq("status", choice(status, "status", CAMPAIGN_STATUSES) as (typeof CAMPAIGN_STATUSES)[number]);
    const { data, error } = await q;
    databaseError(error);
    return json({ campaigns: data ?? [] });
  } catch (error) {
    return failure(error);
  }
}

/** POST → create a campaign (members). */
export async function POST(request: Request) {
  try {
    const { supabase, workspaceId, user } = await productContext();
    const input = parseCampaignInput(await readJson(request, 128 * 1024));
    const { data, error } = await supabase
      .from("campaigns")
      .insert({ ...input, workspace_id: workspaceId, created_by: user.id, owner_id: input.owner_id ?? user.id } as Database["public"]["Tables"]["campaigns"]["Insert"])
      .select()
      .single();
    databaseError(error);
    return json({ campaign: data }, 201);
  } catch (error) {
    return failure(error);
  }
}

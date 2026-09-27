import { ApiError, failure, json, productContext, readJson } from "@/lib/product/api";
import { object } from "@/lib/product/validation";
import { manualAccountRef, parseManualChannel } from "@/lib/publishing/manual-channels";
import { CHANNEL_SAFE_COLUMNS } from "@/lib/workspace";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * POST { platform, handle, displayName? } — owners register an account that is
 * published to manually (or by the managed browser). No credentials are stored
 * and no provider integration is implied (00039 enforces the "manual:" ref).
 */
export async function POST(request: Request) {
  try {
    const { workspaceId, role } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Workspace owner access required");
    const input = parseManualChannel(object(await readJson(request, 4096)));
    // Channel writes are service-role only since 00030 (clients cannot insert projections);
    // the owner check above plus the explicit workspace scope stand in for RLS here.
    const service = await createServiceClient();
    const { data, error } = await service
      .from("channels")
      .insert({
        workspace_id: workspaceId,
        platform: input.platform,
        late_account_id: manualAccountRef(input),
        username: input.handle,
        display_name: input.displayName,
        is_active: true,
      })
      .select(CHANNEL_SAFE_COLUMNS)
      .single();
    if (error?.code === "23505") throw new ApiError(409, "This account is already registered");
    if (error) throw new ApiError(error.code === "23514" ? 400 : 500, error.code === "23514" ? "Invalid manual channel" : "Could not register the channel");
    return json(data, 201);
  } catch (error) {
    return failure(error);
  }
}

import { NextRequest } from "next/server";
import { ApiError, databaseError, failure, json, productContext } from "@/lib/product/api";

/**
 * DELETE /api/v1/channels/[channelId]
 *
 * Deletes the local channel projection (cascades conversations, contact links,
 * etc.). Provider accounts are owned by Agent Social Gateway: if the account
 * is still connected there, the next channel sync re-creates the projection,
 * so disconnect it in the Gateway first to remove it permanently.
 * (The legacy hosted-Zernio disconnect branch was removed; see
 * docs/architecture/DEAD_CODE_AND_REMOVAL_MANIFEST.md.)
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  try {
    const { channelId } = await params;
    const { supabase, workspaceId, role } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Workspace owner access required");

    const { data: channel, error: lookupError } = await supabase
      .from("channels")
      .select("id")
      .eq("id", channelId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    databaseError(lookupError);
    if (!channel) throw new ApiError(404, "Channel not found");

    const { error } = await supabase
      .from("channels")
      .delete()
      .eq("id", channelId)
      .eq("workspace_id", workspaceId);
    databaseError(error);

    return json({
      ok: true,
      notice:
        "Removed from ZernFlow. If the account is still connected in Agent Social Gateway, the next sync will re-import it.",
    });
  } catch (error) {
    return failure(error);
  }
}

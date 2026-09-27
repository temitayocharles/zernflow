import { ApiError, json, productContext } from "@/lib/product/api";
import { createServiceClient } from "@/lib/supabase/server";
import { importLegacyAiKey } from "@/lib/secrets/store";
import { secretFailure } from "@/lib/secrets/http";

/** POST → encrypts the legacy plaintext workspace AI key into the store and clears the column. Owner only. */
export async function POST() {
  try {
    const { workspaceId, role, user } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Workspace owner access required");
    const service = await createServiceClient();
    const result = await importLegacyAiKey(service, { workspaceId, identity: { type: "user", id: user.id } });
    return json(result);
  } catch (error) {
    return secretFailure(error);
  }
}

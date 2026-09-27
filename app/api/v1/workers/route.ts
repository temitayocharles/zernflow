import { ApiError, databaseError, failure, json, productContext, readJson } from "@/lib/product/api";
import { integer, InputError, object, text } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { generateWorkerToken } from "@/lib/workers/tokens";
import { recordAudit } from "@/lib/audit";

const COLUMNS = "id, name, token_prefix, modes, max_concurrency, created_at, last_seen_at, revoked_at";

export async function GET() {
  try {
    const { supabase, workspaceId, role } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Workspace owner access required");
    const { data, error } = await supabase
      .from("worker_identities")
      .select(COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    databaseError(error);
    return json({ workers: data ?? [] });
  } catch (error) {
    return failure(error);
  }
}

/** POST { name, modes?, maxConcurrency? } → returns the token exactly once. */
export async function POST(request: Request) {
  try {
    const { workspaceId, role, user } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Workspace owner access required");
    const body = object(await readJson(request, 4096));
    const modes = body.modes === undefined ? ["browser"] : body.modes;
    if (
      !Array.isArray(modes) ||
      modes.length === 0 ||
      modes.some((m) => !["api", "browser"].includes(m as string))
    ) {
      throw new InputError("modes must be a non-empty subset of api, browser");
    }
    const { token, hash, prefix } = generateWorkerToken();
    const service = await createServiceClient();
    const { data, error } = await service
      .from("worker_identities")
      .insert({
        workspace_id: workspaceId,
        name: text(body.name, "name", 100, true),
        token_hash: hash,
        token_prefix: prefix,
        modes: [...new Set(modes as ("api" | "browser")[])],
        max_concurrency: body.maxConcurrency === undefined ? 1 : integer(body.maxConcurrency, "maxConcurrency", 1, 4),
        created_by: user.id,
      })
      .select(COLUMNS)
      .single();
    databaseError(error);
    await recordAudit(service, {
      workspaceId,
      entityType: "worker_identity",
      entityId: data!.id,
      actorId: user.id,
      action: "worker.token_issued",
      changes: { name: data!.name, modes: data!.modes, prefix },
    });
    return json({ worker: data, token, notice: "Store this token now; it is not shown again." }, 201);
  } catch (error) {
    return failure(error);
  }
}

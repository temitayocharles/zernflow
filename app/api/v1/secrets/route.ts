import { ApiError, databaseError, json, productContext, readJson } from "@/lib/product/api";
import { choice, InputError, object, text, timestamp } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { createSecret, SECRET_KINDS, SECRET_METADATA_COLUMNS } from "@/lib/secrets/store";
import { secretFailure, secretValue } from "@/lib/secrets/http";
import { secretStoreConfigured } from "@/lib/secrets/kek";

/** GET → metadata only (RLS: members of the workspace). Values are never returned. */
export async function GET() {
  try {
    const { supabase, workspaceId } = await productContext();
    const { data, error } = await supabase
      .from("secrets")
      .select(SECRET_METADATA_COLUMNS)
      .eq("workspace_id", workspaceId)
      .neq("status", "deleted")
      .order("created_at", { ascending: false });
    databaseError(error);
    return json({ secrets: data ?? [], storeConfigured: secretStoreConfigured() });
  } catch (error) {
    return secretFailure(error);
  }
}

/** POST { name, kind, value, provider?, description?, binding?, expiresAt? } — owner only. */
export async function POST(request: Request) {
  try {
    const { workspaceId, role, user } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Workspace owner access required");
    const body = object(await readJson(request, 96 * 1024));
    const binding = body.binding === undefined || body.binding === null || body.binding === "" ? null : text(body.binding, "binding", 100);
    if (binding && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(binding)) throw new InputError("Invalid binding");
    const service = await createServiceClient();
    const secret = await createSecret(service, {
      workspaceId,
      name: text(body.name, "name", 200, true),
      kind: choice(body.kind, "kind", SECRET_KINDS) as (typeof SECRET_KINDS)[number],
      value: secretValue(body.value),
      provider: body.provider ? text(body.provider, "provider", 64) : null,
      description: body.description ? text(body.description, "description", 1000) : "",
      binding,
      expiresAt: body.expiresAt ? timestamp(body.expiresAt, "expiresAt") : null,
      identity: { type: "user", id: user.id },
    });
    return json({ secret }, 201);
  } catch (error) {
    return secretFailure(error);
  }
}

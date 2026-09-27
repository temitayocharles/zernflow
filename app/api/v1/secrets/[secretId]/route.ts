import { ApiError, databaseError, json, productContext, readJson } from "@/lib/product/api";
import { choice, object, text, uuid } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { deleteSecret, revokeSecret, rotateSecret, SECRET_METADATA_COLUMNS } from "@/lib/secrets/store";
import { secretFailure, secretValue } from "@/lib/secrets/http";

type Params = { params: Promise<{ secretId: string }> };

/** GET → metadata plus recent access events (members). */
export async function GET(_request: Request, { params }: Params) {
  try {
    const id = uuid((await params).secretId, "secret id");
    const { supabase, workspaceId } = await productContext();
    const [{ data: secret, error }, { data: events, error: eventsError }] = await Promise.all([
      supabase.from("secrets").select(SECRET_METADATA_COLUMNS).eq("workspace_id", workspaceId).eq("id", id).maybeSingle(),
      supabase
        .from("secret_access_events")
        .select("id, action, actor_type, actor_id, purpose, outcome, detail, created_at")
        .eq("workspace_id", workspaceId)
        .eq("secret_id", id)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    databaseError(error ?? eventsError);
    if (!secret) throw new ApiError(404, "Secret not found");
    return json({ secret, events: events ?? [] });
  } catch (error) {
    return secretFailure(error);
  }
}

/** POST { action: "rotate", value } | { action: "revoke", reason? } — owner only. */
export async function POST(request: Request, { params }: Params) {
  try {
    const secretId = uuid((await params).secretId, "secret id");
    const { workspaceId, role, user } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Workspace owner access required");
    const body = object(await readJson(request, 96 * 1024));
    const action = choice(body.action, "action", ["rotate", "revoke"]);
    const service = await createServiceClient();
    const identity = { type: "user" as const, id: user.id };
    const secret =
      action === "rotate"
        ? await rotateSecret(service, { workspaceId, secretId, value: secretValue(body.value), identity })
        : await revokeSecret(service, { workspaceId, secretId, identity, reason: body.reason ? text(body.reason, "reason", 200) : undefined });
    return json({ secret });
  } catch (error) {
    return secretFailure(error);
  }
}

/** DELETE → crypto-shred ciphertext; metadata remains as a tombstone for audit. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const secretId = uuid((await params).secretId, "secret id");
    const { workspaceId, role, user } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Workspace owner access required");
    const service = await createServiceClient();
    await deleteSecret(service, { workspaceId, secretId, identity: { type: "user", id: user.id } });
    return json({ ok: true });
  } catch (error) {
    return secretFailure(error);
  }
}

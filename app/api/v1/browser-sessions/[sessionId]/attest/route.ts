import { json, productContext, readJson } from "@/lib/product/api";
import { object, uuid } from "@/lib/product/validation";
import { attestSession } from "@/lib/browser-sessions/service";
import { requireOwner, sessionFailure, visibleSession } from "@/lib/browser-sessions/http";

/** POST { confirm: boolean, allowExperimental?: boolean } — owner attestation of permitted use. */
export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const sessionId = uuid((await params).sessionId, "session id");
    const { supabase, workspaceId, role, user } = await productContext();
    requireOwner(role);
    const body = object(await readJson(request, 1024));
    const service = await visibleSession(supabase, workspaceId, sessionId);
    const session = await attestSession(service, { workspaceId, sessionId, userId: user.id, confirm: body.confirm === true, allowExperimental: body.allowExperimental === true });
    return json({ session });
  } catch (error) {
    return sessionFailure(error);
  }
}

import { json, productContext } from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";
import { revokeBrowserSession } from "@/lib/browser-sessions/service";
import { requireOwner, sessionFailure, visibleSession } from "@/lib/browser-sessions/http";

/** POST → revoke: session state is crypto-shredded and pending browser jobs are cancelled. */
export async function POST(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const sessionId = uuid((await params).sessionId, "session id");
    const { supabase, workspaceId, role, user } = await productContext();
    requireOwner(role);
    const service = await visibleSession(supabase, workspaceId, sessionId);
    const session = await revokeBrowserSession(service, { workspaceId, sessionId, userId: user.id });
    return json({ status: session.status });
  } catch (error) {
    return sessionFailure(error);
  }
}

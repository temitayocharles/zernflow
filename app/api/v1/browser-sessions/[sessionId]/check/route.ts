import { json, productContext } from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";
import { requestSessionCheck } from "@/lib/browser-sessions/service";
import { sessionFailure, visibleSession } from "@/lib/browser-sessions/http";

/** POST → queue a read-only session check (members; idempotent per 10 minutes). */
export async function POST(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const sessionId = uuid((await params).sessionId, "session id");
    const { supabase, workspaceId, user } = await productContext();
    const service = await visibleSession(supabase, workspaceId, sessionId);
    const task = await requestSessionCheck(service, { workspaceId, sessionId, actorId: user.id, reason: "manual" });
    return json(task, task.created ? 201 : 200);
  } catch (error) {
    return sessionFailure(error);
  }
}

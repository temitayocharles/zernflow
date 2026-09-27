import { ApiError, json, productContext } from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";
import { importStorageState, requestSessionCheck, checkBlocker } from "@/lib/browser-sessions/service";
import { requireOwner, sessionFailure, visibleSession } from "@/lib/browser-sessions/http";
import { MAX_STORAGE_STATE_BYTES } from "@/lib/browser/storage-state";

/**
 * POST (body = Playwright storage-state JSON, raw) → encrypted into the secret
 * store; the response carries only a summary. Owners only. A check is queued
 * automatically when the session is ready to run one.
 */
export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const sessionId = uuid((await params).sessionId, "session id");
    const { supabase, workspaceId, role, user } = await productContext();
    requireOwner(role);
    const raw = await request.text();
    if (raw.length > MAX_STORAGE_STATE_BYTES) throw new ApiError(413, `Session file is larger than ${MAX_STORAGE_STATE_BYTES / 1024} KB`);
    const service = await visibleSession(supabase, workspaceId, sessionId);
    const { session, summary } = await importStorageState(service, { workspaceId, sessionId, raw, identity: { type: "user", id: user.id }, actorId: user.id });
    let checkQueued = false;
    if (!checkBlocker(session)) {
      await requestSessionCheck(service, { workspaceId, sessionId, actorId: user.id, reason: "import" });
      checkQueued = true;
    }
    return json({ status: session.status, summary, checkQueued });
  } catch (error) {
    return sessionFailure(error);
  }
}

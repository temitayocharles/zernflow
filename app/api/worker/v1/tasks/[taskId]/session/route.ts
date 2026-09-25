import { readWorkerJson, workerJson, workerRoute, WorkerApiError } from "@/lib/workers/api";
import { leasedTask } from "@/lib/workers/lease";
import { reportSessionState, SessionError, sessionForLeasedTask } from "@/lib/browser-sessions/service";
import { SecretError } from "@/lib/secrets/store";
import { MAX_STORAGE_STATE_BYTES } from "@/lib/browser/storage-state";

export const runtime = "nodejs";

function mapError(error: unknown): never {
  if (error instanceof SessionError) throw new WorkerApiError(error.status, error.message, error.status === 409 ? "session_unavailable" : "session_denied");
  if (error instanceof SecretError) throw new WorkerApiError(error.code === "not_found" ? 404 : 409, "Session state is unavailable", "session_unavailable");
  throw error;
}

/**
 * GET — decrypted storage state for the browser session of a task this worker
 * currently leases (and nothing else). Audited through the secret store.
 */
export async function GET(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  return workerRoute(request, async (ctx) => {
    if (!ctx.identity.modes.includes("browser")) throw new WorkerApiError(403, "Worker is not a browser worker", "mode_denied");
    const task = await leasedTask(ctx, (await params).taskId);
    if (task.execution_mode !== "browser") throw new WorkerApiError(403, "Task is not a browser task", "mode_denied");
    const out = await sessionForLeasedTask(ctx.supabase, task, ctx.identity.id).catch(mapError);
    return workerJson(out);
  });
}

/** POST { state, reason, storageState? } — session health observed by the executor. */
export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  return workerRoute(request, async (ctx) => {
    if (!ctx.identity.modes.includes("browser")) throw new WorkerApiError(403, "Worker is not a browser worker", "mode_denied");
    const task = await leasedTask(ctx, (await params).taskId);
    if (task.execution_mode !== "browser") throw new WorkerApiError(403, "Task is not a browser task", "mode_denied");
    const body = await readWorkerJson(request, MAX_STORAGE_STATE_BYTES + 4096);
    const session = await reportSessionState(ctx.supabase, task, ctx.identity.id, {
      state: body.state,
      reason: body.reason,
      storageState: typeof body.storageState === "string" ? body.storageState : undefined,
    }).catch(mapError);
    return workerJson({ ok: true, status: session.status });
  });
}

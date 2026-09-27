import "server-only";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { InputError } from "@/lib/product/validation";
import { logger } from "@/lib/observability/log";
import type { ExecutionMode, WorkerIdentityRow } from "@/lib/types/platform";
import type { ServiceClient } from "@/lib/tasks/types";
import { hashesEqual, hashWorkerToken, parseBearerWorkerToken, workerLeaseOwner } from "./tokens";

export interface WorkerContext {
  supabase: ServiceClient;
  identity: Pick<WorkerIdentityRow, "id" | "workspace_id" | "name" | "modes" | "max_concurrency">;
  leaseOwner: string;
}

export class WorkerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "worker_request_failed",
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Authenticates a remote worker by bearer token (SHA-256 lookup, constant-time
 * confirm, revocation check). Workers hold no DB/Vault credentials; every
 * operation is scoped to the identity's workspace and lease.
 */
export async function authenticateWorker(headers: Headers): Promise<WorkerContext> {
  const token = parseBearerWorkerToken(headers.get("authorization"));
  if (!token) throw new WorkerApiError(401, "Worker token required", "worker_unauthorized");
  const hash = hashWorkerToken(token);
  const supabase = await createServiceClient();
  const { data } = await supabase
    .from("worker_identities")
    .select("id, workspace_id, name, modes, max_concurrency, token_hash, revoked_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!data || !hashesEqual(data.token_hash, hash) || data.revoked_at) {
    throw new WorkerApiError(401, "Worker token invalid or revoked", "worker_unauthorized");
  }
  await supabase.from("worker_identities").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
  return {
    supabase,
    identity: {
      id: data.id,
      workspace_id: data.workspace_id,
      name: data.name,
      modes: data.modes as ExecutionMode[],
      max_concurrency: data.max_concurrency,
    },
    leaseOwner: workerLeaseOwner(data.id),
  };
}

export async function readWorkerJson(request: Request, maxBytes = 65_536): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > maxBytes) throw new WorkerApiError(413, "Request body too large");
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkerApiError(400, "Invalid JSON body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkerApiError(400, "JSON object required");
  return value as Record<string, unknown>;
}

export async function workerRoute(
  request: Request,
  handler: (ctx: WorkerContext) => Promise<Response>,
): Promise<Response> {
  try {
    const ctx = await authenticateWorker(request.headers);
    return await handler(ctx);
  } catch (error) {
    if (error instanceof WorkerApiError) return json({ code: error.code, error: error.message }, error.status);
    if (error instanceof InputError) return json({ code: "invalid_request", error: error.message }, 400);
    logger.error("worker_api.unexpected", { error });
    return json({ code: "worker_request_failed", error: "Worker request failed" }, 500);
  }
}

export { json as workerJson };

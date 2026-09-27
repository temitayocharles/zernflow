import "server-only";
import { ApiError, failure } from "@/lib/product/api";
import { createServiceClient } from "@/lib/supabase/server";
import { SecretError } from "@/lib/secrets/store";
import { SecretStoreConfigError } from "@/lib/secrets/kek";
import type { ServiceClient } from "@/lib/tasks/types";
import { SessionError } from "./service";

/** Route error mapping for browser-session endpoints. */
export function sessionFailure(error: unknown) {
  if (error instanceof SessionError) return failure(new ApiError(error.status, error.message));
  if (error instanceof SecretStoreConfigError) return failure(new ApiError(503, "The secret store is not configured, so session state cannot be stored. See System health."));
  if (error instanceof SecretError) return failure(new ApiError(error.code === "not_found" ? 404 : 409, error.message));
  return failure(error);
}

export function requireOwner(role: string) {
  if (role !== "owner") throw new ApiError(403, "Only workspace owners can manage browser sessions");
}

/** Visibility is checked with the caller's RLS client first; mutation uses the service client. */
export async function visibleSession(supabase: { from: ServiceClient["from"] }, workspaceId: string, sessionId: string): Promise<ServiceClient> {
  const { data } = await supabase.from("browser_sessions").select("id").eq("workspace_id", workspaceId).eq("id", sessionId).maybeSingle();
  if (!data) throw new ApiError(404, "Browser session not found");
  return createServiceClient();
}

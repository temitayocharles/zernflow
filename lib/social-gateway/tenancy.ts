import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Agent Social Gateway credentials are deployment-scoped (one Gateway
 * workspace ref). Without a binding, any ZernFlow workspace owner — including
 * every self-registered user — could import all Gateway accounts. Exactly one
 * ZernFlow workspace may project the configured Gateway workspace.
 *
 * Resolution order (fail closed on disagreement):
 *   1. SOCIAL_GATEWAY_BOUND_WORKSPACE_ID (operator configuration)
 *   2. gateway_workspace_bindings row for SOCIAL_GATEWAY_WORKSPACE_REF
 *   3. gateway_workspace_bindings '__deployment__' row (backfilled by 00030)
 */

export type GatewayBinding =
  | { status: "bound"; workspaceId: string; source: "env" | "binding" | "deployment_default" }
  | { status: "unbound" }
  | { status: "conflict"; reason: string };

export interface BindingRow {
  gateway_workspace_ref: string;
  workspace_id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveGatewayBinding(input: {
  envWorkspaceId?: string | null;
  configuredRef: string;
  rows: readonly BindingRow[];
}): GatewayBinding {
  const env = input.envWorkspaceId?.trim() || null;
  if (env && !UUID.test(env)) return { status: "conflict", reason: "SOCIAL_GATEWAY_BOUND_WORKSPACE_ID is not a UUID" };
  const refRow = input.rows.find((r) => r.gateway_workspace_ref === input.configuredRef);
  const defaultRow = input.rows.find((r) => r.gateway_workspace_ref === "__deployment__");
  const dbRow = refRow ?? defaultRow;
  if (env) {
    if (dbRow && dbRow.workspace_id !== env) {
      return { status: "conflict", reason: "Environment binding disagrees with the stored gateway binding" };
    }
    return { status: "bound", workspaceId: env, source: "env" };
  }
  if (refRow) return { status: "bound", workspaceId: refRow.workspace_id, source: "binding" };
  if (defaultRow) return { status: "bound", workspaceId: defaultRow.workspace_id, source: "deployment_default" };
  return { status: "unbound" };
}

export class GatewayTenancyError extends Error {
  readonly code = "gateway_workspace_not_bound";
  constructor(message: string) {
    super(message);
    this.name = "GatewayTenancyError";
  }
}

type AnyClient = SupabaseClient<any, any, any>;

/** Reads bindings with a service-role client (bindings are not client-writable). */
export async function loadGatewayBinding(service: AnyClient): Promise<GatewayBinding> {
  const { data, error } = await service
    .from("gateway_workspace_bindings")
    .select("gateway_workspace_ref, workspace_id");
  if (error) return { status: "conflict", reason: "Gateway binding table unavailable; apply migration 00030" };
  return resolveGatewayBinding({
    envWorkspaceId: process.env.SOCIAL_GATEWAY_BOUND_WORKSPACE_ID,
    configuredRef: process.env.SOCIAL_GATEWAY_WORKSPACE_REF?.trim() || "default",
    rows: (data ?? []) as BindingRow[],
  });
}

export function assertBoundWorkspace(binding: GatewayBinding, workspaceId: string): void {
  if (binding.status === "bound" && binding.workspaceId === workspaceId) return;
  if (binding.status === "conflict") throw new GatewayTenancyError(`Gateway binding conflict: ${binding.reason}`);
  if (binding.status === "unbound") {
    throw new GatewayTenancyError(
      "This deployment's Agent Social Gateway is not bound to a workspace. Set SOCIAL_GATEWAY_BOUND_WORKSPACE_ID.",
    );
  }
  throw new GatewayTenancyError("Agent Social Gateway accounts are bound to a different workspace.");
}

/**
 * Route guard: returns null when `workspaceId` may use the deployment's
 * Gateway accounts, or a JSON 409 describing why not. Loads bindings with the
 * service-role client (not client-readable across tenants).
 */
export async function gatewayBindingViolation(workspaceId: string): Promise<Response | null> {
  const { createServiceClient } = await import("@/lib/supabase/server");
  const binding = await loadGatewayBinding(await createServiceClient());
  try {
    assertBoundWorkspace(binding, workspaceId);
    return null;
  } catch (error) {
    return Response.json(
      {
        code: "gateway_workspace_not_bound",
        error: error instanceof Error ? error.message : "Gateway binding check failed",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
}

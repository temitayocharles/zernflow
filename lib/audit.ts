import "server-only";
import type { Json } from "@/lib/types/database";
import type { ServiceClient } from "@/lib/tasks/types";
import { redact } from "@/lib/observability/log";

/**
 * Append to the workspace audit log (product_activity; members read, only
 * server code and SECURITY DEFINER functions write). Values are redacted.
 */
export async function recordAudit(
  service: ServiceClient,
  entry: {
    workspaceId: string;
    entityType: string;
    entityId: string;
    actorId: string | null;
    action: string;
    changes?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await service.from("product_activity").insert({
    workspace_id: entry.workspaceId,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    actor_id: entry.actorId,
    action: entry.action,
    changes: redact(entry.changes ?? {}) as Json,
  });
  if (error) throw new Error(`Audit write failed: ${error.code ?? "unknown"}`);
}

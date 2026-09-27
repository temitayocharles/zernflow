import "server-only";
import type { ServiceClient } from "@/lib/tasks/types";

/** Notifies every owner of a workspace once per dedupe key (idempotent). */
export async function notifyOwners(
  service: ServiceClient,
  input: { workspaceId: string; title: string; kind: string; entityType: string; entityId: string; dedupeKey: string; extraRecipients?: (string | null | undefined)[] },
): Promise<number> {
  const { data: owners } = await service.from("workspace_members").select("user_id").eq("workspace_id", input.workspaceId).eq("role", "owner");
  const recipients = [...new Set([...(owners ?? []).map((o) => o.user_id), ...(input.extraRecipients ?? []).filter((r): r is string => Boolean(r))])];
  if (!recipients.length) return 0;
  const rows = recipients.map((recipient_id) => ({
    workspace_id: input.workspaceId,
    recipient_id,
    title: input.title.slice(0, 300),
    kind: input.kind,
    entity_type: input.entityType,
    entity_id: input.entityId,
    dedupe_key: input.dedupeKey.slice(0, 200),
  }));
  const { error } = await service.from("operator_notifications").upsert(rows, { onConflict: "workspace_id,recipient_id,dedupe_key", ignoreDuplicates: true });
  if (error) throw new Error(`notification write failed: ${error.code ?? "unknown"}`);
  return rows.length;
}

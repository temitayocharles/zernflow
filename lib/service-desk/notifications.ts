import type { WorkItem } from "@/lib/product/types";
import { workItemSla } from "./work-items";
export function slaNotifications(
  items: readonly WorkItem[],
  recipientId: string,
  now: string,
) {
  return items.flatMap((item) => {
    if (
      item.assignee_id !== recipientId ||
      ["resolved", "closed"].includes(item.status)
    )
      return [];
    const result = workItemSla(item, now);
    return Object.entries(result)
      .filter(([, v]) => v.state === "warning" || v.state === "breached")
      .map(([objective, value]) => ({
        workspace_id: item.workspace_id,
        recipient_id: recipientId,
        title: `ZF-${item.reference}: ${objective === "firstResponse" ? "First response" : "Resolution"} SLA ${value.state}`,
        kind: `sla_${value.state}`,
        entity_type: "work_items",
        entity_id: item.id,
        dedupe_key: `sla:${item.id}:${objective}:${value.state}`,
      }));
  });
}

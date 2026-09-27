import "server-only";
import type { ServiceClient } from "@/lib/tasks/types";

const WARN_DAYS = 7;

/**
 * Notifies workspace owners about active secrets expiring within 7 days (or
 * already expired). Idempotent via the notifications dedupe key; bounded batch.
 */
export async function sweepSecretExpiry(supabase: ServiceClient, now = new Date()) {
  const horizon = new Date(now.getTime() + WARN_DAYS * 86400_000).toISOString();
  const { data: secrets, error } = await supabase
    .from("secrets")
    .select("id, workspace_id, name, expires_at")
    .eq("status", "active")
    .lte("expires_at", horizon)
    .order("expires_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(`secret expiry scan failed: ${error.code ?? "unknown"}`);
  if (!secrets?.length) return { expiring: 0, notified: 0 };

  const workspaceIds = [...new Set(secrets.map((s) => s.workspace_id))];
  const { data: owners, error: ownerError } = await supabase
    .from("workspace_members")
    .select("workspace_id, user_id")
    .in("workspace_id", workspaceIds)
    .eq("role", "owner");
  if (ownerError) throw new Error(`owner lookup failed: ${ownerError.code ?? "unknown"}`);

  const rows = secrets.flatMap((s) => {
    const expired = new Date(s.expires_at!).getTime() <= now.getTime();
    return (owners ?? [])
      .filter((o) => o.workspace_id === s.workspace_id)
      .map((o) => ({
        workspace_id: s.workspace_id,
        recipient_id: o.user_id,
        title: `${expired ? "Secret expired" : "Secret expires soon"}: ${s.name}`.slice(0, 300),
        kind: expired ? "secret_expired" : "secret_expiring",
        entity_type: "secrets",
        entity_id: s.id,
        dedupe_key: `secret-${expired ? "expired" : "expiring"}:${s.id}:${s.expires_at}`,
      }));
  });
  if (rows.length === 0) return { expiring: secrets.length, notified: 0 };
  const { error: insertError } = await supabase
    .from("operator_notifications")
    .upsert(rows, { onConflict: "workspace_id,recipient_id,dedupe_key", ignoreDuplicates: true });
  if (insertError) throw new Error(`notification write failed: ${insertError.code ?? "unknown"}`);
  return { expiring: secrets.length, notified: rows.length };
}

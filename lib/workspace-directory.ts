import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Display labels for the members of one workspace (email local part or name).
 * Service client: workspace_members RLS only returns the caller's own row and
 * auth.users is not exposed. Only members of `workspaceId` are resolved, so ids
 * from other tenants never produce a label.
 */
export async function memberDirectory(workspaceId: string): Promise<Map<string, { label: string; email: string | null; role: string }>> {
  const service = await createServiceClient();
  const { data: members } = await service.from("workspace_members").select("user_id, role").eq("workspace_id", workspaceId).limit(500);
  const entries = await Promise.all(
    (members ?? []).map(async (m) => {
      const { data } = await service.auth.admin.getUserById(m.user_id);
      const u = data?.user;
      const label = (u?.user_metadata?.full_name as string | undefined) ?? (u?.user_metadata?.name as string | undefined) ?? u?.email?.split("@")[0] ?? "Member";
      return [m.user_id, { label, email: u?.email ?? null, role: m.role }] as const;
    }),
  );
  return new Map(entries);
}

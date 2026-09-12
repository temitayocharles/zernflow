import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
export async function crmOptions(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
) {
  const [companies, contacts, members] = await Promise.all([
    supabase
      .from("companies")
      .select("id,name")
      .eq("workspace_id", workspaceId)
      .order("name")
      .limit(200),
    supabase
      .from("contacts")
      .select("id,display_name,email")
      .eq("workspace_id", workspaceId)
      .order("display_name")
      .limit(200),
    supabase.rpc("workspace_operator_directory", {
      p_workspace_id: workspaceId,
    }),
  ]);
  if (companies.error || contacts.error || members.error)
    throw new Error(
      "CRM data unavailable. Confirm product migrations 00021–00026 are applied.",
    );
  return {
    members: (members.data ?? []).map((m) => ({
      id: m.user_id,
      label: `${m.display_name} (${m.role}) · ${m.user_id.slice(0, 8)}`,
    })),
    companies: (companies.data ?? []).map((c) => ({ id: c.id, label: c.name })),
    contacts: (contacts.data ?? []).map((c) => ({
      id: c.id,
      label: c.display_name ?? c.email ?? c.id,
    })),
  };
}

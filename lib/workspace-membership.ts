import "server-only";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { WORKSPACE_COOKIE } from "@/lib/workspace";


export type SelectedMembership = { workspace_id: string; role: string };

/**
 * Resolves the caller's active workspace for API routes: the workspace chosen
 * in the switcher cookie when the user is a member of it, otherwise their
 * first membership (same semantics as lib/workspace.ts getWorkspace, without
 * redirects). Replaces ad-hoc `limit(1)` lookups that silently acted on the
 * wrong workspace for multi-workspace users.
 */
export async function selectedMembership(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<SelectedMembership | null> {
  let selected: string | undefined;
  try {
    selected = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  } catch {
    selected = undefined; // outside a request scope (tests/scripts)
  }
  if (selected) {
    const { data } = await supabase
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", userId)
      .eq("workspace_id", selected)
      .maybeSingle();
    if (data) return data;
  }
  const { data } = await supabase
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

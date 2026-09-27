import { cache } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const WORKSPACE_COOKIE = "zernflow_workspace_id";

/**
 * Browser-safe workspace columns. Legacy secret columns (ai_api_key,
 * late_api_key_encrypted, webhook_secret) are server-only since migration
 * 00030 and must never be selected with a user client or sent to the client.
 */
export const WORKSPACE_SAFE_COLUMNS =
  "id, name, slug, global_keywords, ai_provider, created_at, updated_at";

/** Browser-safe channel columns (webhook_secret is server-only since 00030). */
export const CHANNEL_SAFE_COLUMNS =
  "id, workspace_id, platform, late_account_id, username, display_name, profile_picture, webhook_id, is_active, created_at, updated_at, last_comment_cursor, comment_rules";

/**
 * Cached per-request: deduplicates across layout + page in the same render.
 * Reads workspace ID from cookie if set; falls back to first workspace.
 */
export const getWorkspace = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const cookieStore = await cookies();
  const selectedId = cookieStore.get(WORKSPACE_COOKIE)?.value;

  // Try cookie workspace first
  if (selectedId) {
    const { data: membership } = await supabase
      .from("workspace_members")
      .select(`workspace_id, role, workspaces(${WORKSPACE_SAFE_COLUMNS})`)
      .eq("user_id", user.id)
      .eq("workspace_id", selectedId)
      .single();

    if (membership?.workspaces) {
      return {
        user,
        workspace: membership.workspaces,
        role: membership.role,
        supabase,
      };
    }
  }

  // Fallback to first workspace
  const { data: membership } = await supabase
    .from("workspace_members")
    .select(`workspace_id, role, workspaces(${WORKSPACE_SAFE_COLUMNS})`)
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership?.workspaces) redirect("/login");

  return {
    user,
    workspace: membership.workspaces,
    role: membership.role,
    supabase,
  };
});

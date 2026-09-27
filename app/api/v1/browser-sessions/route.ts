import { databaseError, json, productContext, readJson } from "@/lib/product/api";
import { createServiceClient } from "@/lib/supabase/server";
import { createBrowserSession, parseCreateInput, SESSION_COLUMNS } from "@/lib/browser-sessions/service";
import { requireOwner, sessionFailure } from "@/lib/browser-sessions/http";
import { browserPlatforms } from "@/lib/browser/registry";

/** GET → sessions (members; secret ids are never used client-side) + platform catalog. */
export async function GET() {
  try {
    const { supabase, workspaceId } = await productContext();
    const { data, error } = await supabase.from("browser_sessions").select(SESSION_COLUMNS).eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(100);
    databaseError(error);
    return json({ sessions: data ?? [], platforms: browserPlatforms() });
  } catch (error) {
    return sessionFailure(error);
  }
}

/** POST { platform, label, accountHint? } → owner creates a session placeholder. */
export async function POST(request: Request) {
  try {
    const { workspaceId, role, user } = await productContext();
    requireOwner(role);
    const input = parseCreateInput(await readJson(request, 4096));
    const session = await createBrowserSession(await createServiceClient(), { workspaceId, userId: user.id, ...input });
    return json({ session }, 201);
  } catch (error) {
    return sessionFailure(error);
  }
}

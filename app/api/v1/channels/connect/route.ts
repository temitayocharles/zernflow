import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createSocialGatewayClient,
  type GatewayPlatform,
} from "@/lib/social-gateway/client";

async function getWorkspace(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id, workspaces(*)")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership?.workspaces) return null;
  return membership.workspaces;
}

/**
 * POST /api/v1/channels/connect
 *
 * Returns the configured social gateway connection URL for the given platform.
 * The configured gateway handles the connection flow (OAuth, page selection, etc.)
 * and redirects back to our callback URL when done.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const workspace = await getWorkspace(supabase);
  if (!workspace)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });


  const { platform } = await request.json();

  const supported = ["facebook", "instagram", "twitter", "telegram", "bluesky", "reddit"];
  if (!platform || !supported.includes(platform)) {
    return NextResponse.json(
      { error: `Unsupported platform. Must be one of: ${supported.join(", ")}` },
      { status: 400 }
    );
  }

  const gateway = createSocialGatewayClient();

  try {
    // Resolve the gateway profile scope
    const profilesRes = await gateway.profiles.list();
    const profiles = profilesRes.data?.profiles ?? [];
    if (profiles.length === 0) {
      return NextResponse.json(
        { error: "No social gateway profile is available." },
        { status: 400 }
      );
    }

    const profileId = profiles[0]._id!;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const callbackUrl = `${appUrl}/dashboard/channels/callback`;

    // The gateway handles provider-specific authorization and account selection
    const res = await gateway.connections.getConnectUrl({
      platform: platform as GatewayPlatform,
      profileId,
      redirectUrl: callbackUrl,
    });

    if (!res.data?.authUrl) {
      return NextResponse.json({ error: "Failed to get connect URL" }, { status: 500 });
    }

    return NextResponse.json({ authUrl: res.data.authUrl });
  } catch (error) {
    console.error("Failed to get connect URL:", error);
    return NextResponse.json(
      { error: `Connection failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}

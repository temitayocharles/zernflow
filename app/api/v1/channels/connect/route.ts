import { NextResponse } from "next/server";
import { SocialGatewayError } from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import { getWorkspace } from "@/lib/workspace";

type ConnectablePlatform = "facebook" | "instagram";

function isConnectablePlatform(value: unknown): value is ConnectablePlatform {
  return value === "facebook" || value === "instagram";
}

function callbackUrl(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const base = new URL(configured || request.url);
  if (process.env.NODE_ENV === "production" && base.protocol !== "https:") {
    throw new Error("Production channel callbacks must use HTTPS");
  }
  base.pathname = "/dashboard/channels/callback";
  base.search = "";
  base.hash = "";
  return base.toString();
}

export async function POST(request: Request) {
  const { role, workspace } = await getWorkspace();
  if (role !== "owner") {
    return NextResponse.json(
      { code: "workspace_owner_required", error: "Workspace owner access required" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { code: "invalid_request", error: "A valid JSON request body is required" },
      { status: 400 },
    );
  }
  const platform =
    typeof body === "object" && body !== null && "platform" in body
      ? (body as { platform?: unknown }).platform
      : undefined;
  if (!isConnectablePlatform(platform)) {
    return NextResponse.json(
      { code: "unsupported_platform", error: "Only Facebook and Instagram are supported" },
      { status: 422 },
    );
  }

  try {
    const gateway = requireSocialGatewayClient();
    const readiness = await gateway.getProviderReadiness("meta");
    if (!readiness.configured || !readiness.platforms.includes(platform)) {
      return NextResponse.json(
        {
          code: "provider_onboarding_not_configured",
          error: "Meta onboarding is not configured for this deployment yet.",
        },
        { status: 503 },
      );
    }
    const connection = await gateway.startConnection(platform, {
      profileId: workspace.id,
      redirectUrl: callbackUrl(request),
    });
    return NextResponse.json(connection, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof SocialGatewayError) {
      const status = error.status && error.status >= 400 ? error.status : 503;
      return NextResponse.json(
        { code: error.code, error: error.message },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { code: "provider_connection_failed", error: "Unable to start the Meta connection" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

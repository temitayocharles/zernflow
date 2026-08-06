import { NextResponse } from "next/server";
import {
  SocialGatewayConfigurationError,
  SocialGatewayError,
} from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import type { GatewayAccountPlatform } from "@/lib/social-gateway/types";
import { getWorkspace } from "@/lib/workspace";

const metaPlatforms = new Set<GatewayAccountPlatform>(["facebook", "instagram"]);

function gatewayFailure(error: unknown): NextResponse {
  if (error instanceof SocialGatewayConfigurationError) {
    return NextResponse.json({ code: error.code, error: error.message }, { status: 503 });
  }
  if (error instanceof SocialGatewayError) {
    return NextResponse.json(
      { code: error.code, error: error.message, retryable: error.retryable },
      { status: error.retryable ? 503 : 502 },
    );
  }
  console.error("[channels/connect] unexpected failure", {
    errorType: error instanceof Error ? error.name : typeof error,
  });
  return NextResponse.json(
    { code: "channel_connection_failed", error: "Channel connection could not be started" },
    { status: 500 },
  );
}

function applicationBaseUrl(request: Request): URL {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const base = new URL(configured || request.url);
  if (
    process.env.NODE_ENV === "production" &&
    base.protocol !== "https:" &&
    !new Set(["localhost", "127.0.0.1", "::1"]).has(base.hostname)
  ) {
    throw new SocialGatewayConfigurationError(
      "NEXT_PUBLIC_APP_URL must use HTTPS in production",
    );
  }
  return base;
}

export async function POST(request: Request) {
  const { workspace, role } = await getWorkspace();
  if (role !== "owner") {
    return NextResponse.json(
      { code: "workspace_owner_required", error: "Workspace owner access required" },
      { status: 403 },
    );
  }
  let platform: GatewayAccountPlatform;
  try {
    const body = (await request.json()) as { platform?: unknown };
    if (typeof body.platform !== "string") throw new Error("missing platform");
    platform = body.platform as GatewayAccountPlatform;
  } catch {
    return NextResponse.json(
      { code: "invalid_channel_connection", error: "A channel platform is required" },
      { status: 400 },
    );
  }
  if (!metaPlatforms.has(platform)) {
    return NextResponse.json(
      {
        code: "provider_onboarding_not_supported",
        error: "Self-service onboarding is currently available only for Facebook and Instagram",
      },
      { status: 422 },
    );
  }
  try {
    const gateway = requireSocialGatewayClient();
    const redirectUrl = new URL(
      "/dashboard/channels/callback",
      applicationBaseUrl(request),
    ).toString();
    const connection = await gateway.startConnection({
      platform,
      profileId: workspace.id,
      redirectUrl,
    });
    return NextResponse.json(connection, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return gatewayFailure(error);
  }
}

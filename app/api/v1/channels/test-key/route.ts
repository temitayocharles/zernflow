import { NextResponse } from "next/server";

/**
 * Legacy endpoint retained temporarily so older browser bundles fail safely.
 * Provider and gateway credentials are deployment-managed server secrets and
 * must never be accepted from a browser request or persisted in workspace rows.
 */
export async function POST() {
  return NextResponse.json(
    {
      code: "browser_managed_credentials_retired",
      error:
        "Provider credentials are configured server-side. Use channel synchronization after the Agent Social Gateway deployment is configured.",
      replacement: "/api/v1/channels/sync",
    },
    {
      status: 410,
      headers: {
        Deprecation: "true",
        Link: '</api/v1/channels/sync>; rel="successor-version"',
      },
    },
  );
}

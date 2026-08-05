import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/workspace";

export async function POST() {
  const { role } = await getWorkspace();
  if (role !== "owner") {
    return NextResponse.json(
      { code: "workspace_owner_required", error: "Workspace owner access required" },
      { status: 403 },
    );
  }

  return NextResponse.json(
    {
      code: "provider_onboarding_not_configured",
      error:
        "New channel connections are not enabled yet. Configure a Gateway provider application, then retry.",
    },
    { status: 503 },
  );
}

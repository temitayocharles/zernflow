import { beforeEach, describe, expect, it, vi } from "vitest";

const { getWorkspaceMock, readinessMock, startConnectionMock } = vi.hoisted(() => ({
  getWorkspaceMock: vi.fn(),
  readinessMock: vi.fn(),
  startConnectionMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspace: getWorkspaceMock,
}));

vi.mock("@/lib/social-gateway/server", () => ({
  requireSocialGatewayClient: () => ({
    getProviderReadiness: readinessMock,
    startConnection: startConnectionMock,
  }),
}));

import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("https://app.zernflow.com/api/v1/channels/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/channels/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.zernflow.com";
  });

  it("requires workspace owner access", async () => {
    getWorkspaceMock.mockResolvedValueOnce({
      role: "member",
      workspace: { id: "workspace-1" },
    });
    const response = await POST(request({ platform: "instagram" }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "workspace_owner_required",
    });
  });

  it("rejects unsupported platforms before contacting the gateway", async () => {
    getWorkspaceMock.mockResolvedValueOnce({
      role: "owner",
      workspace: { id: "workspace-1" },
    });
    const response = await POST(request({ platform: "telegram" }));
    expect(response.status).toBe(422);
    expect(readinessMock).not.toHaveBeenCalled();
  });

  it("returns an explicit boundary while Meta is not configured", async () => {
    getWorkspaceMock.mockResolvedValueOnce({
      role: "owner",
      workspace: { id: "workspace-1" },
    });
    readinessMock.mockResolvedValueOnce({
      provider: "meta",
      configured: false,
      application: null,
      platforms: [],
    });
    const response = await POST(request({ platform: "instagram" }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "provider_onboarding_not_configured",
    });
  });

  it("starts an owner-scoped Meta connection with an exact callback", async () => {
    getWorkspaceMock.mockResolvedValueOnce({
      role: "owner",
      workspace: { id: "workspace-1" },
    });
    readinessMock.mockResolvedValueOnce({
      provider: "meta",
      configured: true,
      application: "Temitayo Charlie Tech - ZernFlow owner test",
      platforms: ["facebook", "instagram"],
    });
    startConnectionMock.mockResolvedValueOnce({
      authUrl: "https://gateway.example/v1/connections/sessions/session-1/authorize?state=opaque",
      session_id: "session-1",
      expires_at: "2026-08-06T09:00:00Z",
    });

    const response = await POST(request({ platform: "instagram" }));

    expect(response.status).toBe(200);
    expect(startConnectionMock).toHaveBeenCalledWith("instagram", {
      profileId: "workspace-1",
      redirectUrl: "https://app.zernflow.com/dashboard/channels/callback",
    });
    await expect(response.json()).resolves.toMatchObject({ session_id: "session-1" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

import { describe, expect, it, vi } from "vitest";

const { getWorkspaceMock, requireGatewayMock, startConnectionMock } = vi.hoisted(() => ({
  getWorkspaceMock: vi.fn(),
  requireGatewayMock: vi.fn(),
  startConnectionMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspace: getWorkspaceMock }));
vi.mock("@/lib/social-gateway/server", () => ({
  requireSocialGatewayClient: requireGatewayMock,
}));

import { POST } from "./route";

function request(platform: string): Request {
  return new Request("https://app.zernflow.com/api/v1/channels/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform }),
  });
}

describe("POST /api/v1/channels/connect", () => {
  it("requires workspace owner access", async () => {
    getWorkspaceMock.mockResolvedValueOnce({
      role: "member",
      workspace: { id: "workspace-1" },
    });
    const response = await POST(request("instagram"));
    expect(response.status).toBe(403);
  });

  it("rejects platforms without a self-service adapter", async () => {
    getWorkspaceMock.mockResolvedValueOnce({
      role: "owner",
      workspace: { id: "workspace-1" },
    });
    const response = await POST(request("telegram"));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "provider_onboarding_not_supported",
    });
  });

  it("starts a server-side Meta connection without accepting credentials", async () => {
    getWorkspaceMock.mockResolvedValueOnce({
      role: "owner",
      workspace: { id: "workspace-1" },
    });
    startConnectionMock.mockResolvedValueOnce({
      authUrl: "https://gateway.example/v1/connections/sessions/1/authorize?state=opaque",
      session_id: "1",
      expires_at: "2026-08-06T07:00:00Z",
    });
    requireGatewayMock.mockReturnValueOnce({ startConnection: startConnectionMock });

    const response = await POST(request("instagram"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(startConnectionMock).toHaveBeenCalledWith({
      platform: "instagram",
      profileId: "workspace-1",
      redirectUrl: "https://app.zernflow.com/dashboard/channels/callback",
    });
    expect(JSON.stringify(await response.json())).not.toContain("access_token");
  });
});

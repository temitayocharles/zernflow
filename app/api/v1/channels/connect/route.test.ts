import { describe, expect, it, vi } from "vitest";

const { getWorkspaceMock } = vi.hoisted(() => ({
  getWorkspaceMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  getWorkspace: getWorkspaceMock,
}));

import { POST } from "./route";

describe("POST /api/v1/channels/connect", () => {
  it("requires workspace owner access", async () => {
    getWorkspaceMock.mockResolvedValueOnce({ role: "member" });
    const response = await POST();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "workspace_owner_required",
    });
  });

  it("returns an explicit provider-configuration boundary for owners", async () => {
    getWorkspaceMock.mockResolvedValueOnce({ role: "owner" });
    const response = await POST();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "provider_onboarding_not_configured",
    });
  });
});

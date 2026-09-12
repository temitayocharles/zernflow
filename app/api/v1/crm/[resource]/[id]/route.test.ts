import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  single: vi.fn(),
  eq: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/product/api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/product/api")>(
      "@/lib/product/api",
    );
  return { ...actual, productContext: mocks.context };
});
import { GET, PATCH } from "./route";
import { ApiError } from "@/lib/product/api";
const id = "00000000-0000-4000-8000-000000000001";
const params = Promise.resolve({ resource: "companies", id });
beforeEach(() => {
  vi.clearAllMocks();
  const chain = {
    eq: mocks.eq,
    select: () => chain,
    maybeSingle: mocks.single,
  };
  mocks.eq.mockReturnValue(chain);
  mocks.update.mockReturnValue(chain);
  mocks.context.mockResolvedValue({
    workspaceId: "trusted-workspace",
    supabase: { from: () => ({ select: () => chain, update: mocks.update }) },
  });
  mocks.single.mockResolvedValue({ data: { id, version: 2 }, error: null });
});
describe("CRM scoped API", () => {
  it("always scopes reads to selected authorized workspace", async () => {
    expect(
      (await GET(new Request("https://app.example"), { params })).status,
    ).toBe(200);
    expect(mocks.eq).toHaveBeenCalledWith("workspace_id", "trusted-workspace");
  });
  it("rejects unauthenticated access", async () => {
    mocks.context.mockRejectedValue(
      new ApiError(401, "Authentication required"),
    );
    expect(
      (await GET(new Request("https://app.example"), { params })).status,
    ).toBe(401);
  });
  it("rejects caller-supplied tenant identity", async () => {
    expect(
      (
        await PATCH(
          new Request("https://app.example", {
            method: "PATCH",
            body: JSON.stringify({
              version: 1,
              name: "X",
              workspace_id: "other",
            }),
          }),
          { params },
        )
      ).status,
    ).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("uses optimistic version and exposes stale-write conflict", async () => {
    mocks.single.mockResolvedValue({ data: null, error: null });
    expect(
      (
        await PATCH(
          new Request("https://app.example", {
            method: "PATCH",
            body: JSON.stringify({ version: 1, name: "X" }),
          }),
          { params },
        )
      ).status,
    ).toBe(409);
    expect(mocks.eq).toHaveBeenCalledWith("version", 1);
  });
  it("does not leak RLS-hidden records", async () => {
    mocks.single.mockResolvedValue({ data: null, error: null });
    expect(
      (await GET(new Request("https://app.example"), { params })).status,
    ).toBe(404);
  });
});

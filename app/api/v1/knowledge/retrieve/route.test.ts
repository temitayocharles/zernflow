import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  sources: vi.fn(),
  eq: vi.fn(),
  retrieve: vi.fn(),
  construct: vi.fn(),
}));
vi.mock("@/lib/product/api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/product/api")>(
      "@/lib/product/api",
    );
  return { ...actual, productContext: mocks.context };
});
vi.mock("@/lib/knowledge/client", () => ({
  HttpKnowledgeClient: class {
    constructor(endpoint: string, token: string) {
      mocks.construct(endpoint, token);
    }
    retrieve = mocks.retrieve;
  },
}));
import { POST } from "./route";
import { ApiError } from "@/lib/product/api";
const source = "00000000-0000-4000-8000-000000000001";
const call = (body: unknown) =>
  POST(
    new Request("https://app.example/api/v1/knowledge/retrieve", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("KNOWLEDGE_RETRIEVAL_URL", "https://knowledge.example/retrieve");
  vi.stubEnv("KNOWLEDGE_API_TOKEN", "test-only");
  const chain = { eq: mocks.eq, in: mocks.sources };
  mocks.eq.mockReturnValue(chain);
  mocks.context.mockResolvedValue({
    workspaceId: "trusted-workspace",
    supabase: { from: () => ({ select: () => chain }) },
  });
  mocks.sources.mockResolvedValue({
    data: [{ id: source, source_ref: "permitted-ref" }],
    error: null,
  });
  mocks.retrieve.mockResolvedValue({
    requestId: "r",
    indexingStatus: "ready",
    citations: [],
  });
});
import { afterEach } from "vitest";
afterEach(() => vi.unstubAllEnvs());
describe("knowledge API authorization boundary", () => {
  it("requires authentication", async () => {
    mocks.context.mockRejectedValue(
      new ApiError(401, "Authentication required"),
    );
    expect((await call({ query: "q", sourceIds: [source] })).status).toBe(401);
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it("rejects disabled or foreign source selection before external access", async () => {
    mocks.sources.mockResolvedValue({ data: [], error: null });
    expect((await call({ query: "q", sourceIds: [source] })).status).toBe(403);
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it("ignores supplied tenant refs and scopes actual selected sources", async () => {
    expect(
      (
        await call({
          query: "q",
          sourceIds: [source],
          workspaceRef: "attacker",
        })
      ).status,
    ).toBe(200);
    expect(mocks.eq).toHaveBeenCalledWith("workspace_id", "trusted-workspace");
    expect(mocks.eq).toHaveBeenCalledWith("enabled", true);
    expect(mocks.retrieve).toHaveBeenCalledWith({
      workspaceRef: "trusted-workspace",
      query: "q",
      sourceRefs: ["permitted-ref"],
      limit: 5,
    });
  });
  it("returns explicit not-configured boundary", async () => {
    vi.stubEnv("KNOWLEDGE_RETRIEVAL_URL", "");
    expect((await call({ query: "q", sourceIds: [source] })).status).toBe(503);
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it("does not leak upstream errors or tokens", async () => {
    mocks.retrieve.mockRejectedValue(new Error("secret-token upstream"));
    const r = await call({ query: "q", sourceIds: [source] });
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain("secret-token");
  });
  it("rejects oversized query and empty source selection", async () => {
    expect(
      (await call({ query: "x".repeat(4001), sourceIds: [source] })).status,
    ).toBe(400);
    expect((await call({ query: "q", sourceIds: [] })).status).toBe(400);
  });
});

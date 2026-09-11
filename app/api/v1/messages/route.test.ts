import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), single: vi.fn(), getConversation: vi.fn(), reply: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({
  auth: { getUser: mocks.auth },
  from: () => ({ select: () => ({ eq: () => ({ single: mocks.single }) }) }),
}) }));
vi.mock("@/lib/social-gateway/server", () => ({ requireSocialGatewayClient: () => ({ getConversation: mocks.getConversation, replyToConversation: mocks.reply }) }));
import { GET, POST } from "./route";
const request = (query: string) => new NextRequest(`https://app.example.com/api/v1/messages?${query}`);
describe("message API boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ data: { user: { id: "operator" } } });
    mocks.single.mockResolvedValue({ data: { id: "local", late_conversation_id: "remote", workspace_id: "workspace" }, error: null });
    mocks.getConversation.mockResolvedValue({ messages: [], next_message_cursor: "next" });
  });
  it("rejects unauthenticated reads without contacting Gateway", async () => {
    mocks.auth.mockResolvedValue({ data: { user: null } });
    expect((await GET(request("conversationId=local"))).status).toBe(401);
    expect(mocks.getConversation).not.toHaveBeenCalled();
  });
  it("fails closed when RLS hides a conversation", async () => {
    mocks.single.mockResolvedValue({ data: null, error: null });
    expect((await GET(request("conversationId=foreign"))).status).toBe(404);
    expect(mocks.getConversation).not.toHaveBeenCalled();
  });
  it("forwards validated paging to the authorized remote conversation", async () => {
    const response = await GET(request("conversationId=local&paginated=true&cursor=opaque&limit=30"));
    expect(mocks.getConversation).toHaveBeenCalledWith("remote", { messageCursor: "opaque", messageLimit: 30 });
    expect(await response.json()).toEqual({ messages: [], nextCursor: "next" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("preserves legacy array responses", async () => {
    expect(await (await GET(request("conversationId=local"))).json()).toEqual([]);
  });
  it("rejects invalid page size before remote calls", async () => {
    expect((await GET(request("conversationId=local&limit=201"))).status).toBe(400);
    expect(mocks.getConversation).not.toHaveBeenCalled();
  });
  it.each([null, [], "text", 42])("rejects non-object send bodies: %s", async body => {
    const response = await POST(new NextRequest("https://app.example.com/api/v1/messages", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
    expect(response.status).toBe(400);
    expect(mocks.reply).not.toHaveBeenCalled();
  });
});

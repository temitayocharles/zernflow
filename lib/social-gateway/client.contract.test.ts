import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSocialGatewayHttpAdapter } from "./client";

function jsonResponse(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createClient(): AgentSocialGatewayHttpAdapter {
  return new AgentSocialGatewayHttpAdapter({
    baseUrl: "https://gateway.example.test/",
    apiKey: "gateway-key",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentSocialGatewayHttpAdapter endpoint contract", () => {
  it("starts provider connections with the canonical request shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ authUrl: "https://provider.example.test/oauth" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createClient().connections.getConnectUrl({
      platform: "instagram",
      profileId: "profile-1",
      redirectUrl: "https://zernflow.example.test/settings/channels",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test/v1/connections/instagram",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          profile_id: "profile-1",
          redirect_url: "https://zernflow.example.test/settings/channels",
        }),
      }),
    );
  });

  it("lists, reads and sends conversation messages through account-scoped routes", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient();

    await client.conversations.list({
      accountId: "account/1",
      limit: 50,
      sortOrder: "desc",
      cursor: "cursor token",
    });
    await client.conversations.messages({
      accountId: "account/1",
      conversationId: "thread/1",
    });
    await client.conversations.send({
      accountId: "account/1",
      conversationId: "thread/1",
      message: "Hello",
      attachmentUrl: "https://cdn.example.test/image.png",
      attachmentType: "image",
      buttons: [{ title: "Open", url: "https://example.test" }],
      quickReplies: [{ title: "Yes", payload: "yes" }],
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://gateway.example.test/v1/accounts/account%2F1/conversations?limit=50&sort_order=desc&cursor=cursor+token",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://gateway.example.test/v1/accounts/account%2F1/conversations/thread%2F1/messages",
    );
    expect(fetchMock.mock.calls[2]).toEqual([
      "https://gateway.example.test/v1/accounts/account%2F1/conversations/thread%2F1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          message: "Hello",
          attachment_url: "https://cdn.example.test/image.png",
          attachment_type: "image",
          buttons: [{ title: "Open", url: "https://example.test" }],
          quick_replies: [{ title: "Yes", payload: "yes" }],
        }),
      }),
    ]);
  });

  it("disconnects accounts using the canonical DELETE route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await createClient().accounts.disconnect({ accountId: "account/1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test/v1/accounts/account%2F1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("routes public and private comment replies with the gateway payload contract", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ data: {} })));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient();

    await client.comments.replyPublic({
      accountId: "account/1",
      postId: "post-1",
      commentId: "comment/1",
      message: "Public reply",
    });
    await client.comments.replyPrivate({
      accountId: "account/1",
      postId: "post-1",
      commentId: "comment/1",
      message: "Private reply",
    });

    expect(fetchMock.mock.calls[0]).toEqual([
      "https://gateway.example.test/v1/accounts/account%2F1/comments/comment%2F1/replies",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ post_id: "post-1", message: "Public reply" }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "https://gateway.example.test/v1/accounts/account%2F1/comments/comment%2F1/private-replies",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ post_id: "post-1", message: "Private reply" }),
      }),
    ]);
  });

  it("creates and updates delivery webhooks without exposing their secret in responses", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ _id: "webhook-1", secret: null, events: ["message.created"] }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient();
    const input = {
      name: "ZernFlow",
      url: "https://zernflow.example.test/api/webhooks/gateway",
      secret: "runtime-injected-signing-secret",
      events: ["message.created"],
    };

    const created = await client.webhooks.create(input);
    await client.webhooks.update({ id: "webhook/1", ...input });

    expect(fetchMock.mock.calls[0]).toEqual([
      "https://gateway.example.test/v1/webhooks",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "https://gateway.example.test/v1/webhooks/webhook%2F1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ id: "webhook/1", ...input }),
      }),
    ]);
    expect(JSON.stringify(created.data)).not.toContain("runtime-injected-signing-secret");
  });

  it("applies the API key and no-store policy to every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ profiles: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await createClient().profiles.list();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test/v1/profiles",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-API-Key": "gateway-key",
        }),
      }),
    );
  });
});

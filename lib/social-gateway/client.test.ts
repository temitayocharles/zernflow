import { describe, expect, it, vi } from "vitest";
import {
  HttpSocialGatewayClient,
  SocialGatewayConfigurationError,
  SocialGatewayError,
} from "./client";

const OPERATOR_KEY = "operator-api-key-with-at-least-24-characters";
const ADMIN_KEY = "admin-api-key-with-at-least-24-characters";
const AGENT_KEY = "agent-credential-with-at-least-24-characters";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HttpSocialGatewayClient", () => {
  it("keeps the operator credential server-side and sends bounded scope headers", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ items: [], next_cursor: null }),
    );
    const client = new HttpSocialGatewayClient({
      baseUrl: "https://gateway.example.test",
      operatorApiKey: OPERATOR_KEY,
      workspaceRef: "workspace-1",
      actorRef: "zernflow-operator",
      fetchImpl: fetchMock as typeof fetch,
      production: true,
    });

    await client.listConversations({ limit: 20, provider: "telegram" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(input.toString()).toBe(
      "https://gateway.example.test/v1/conversations?limit=20&provider=telegram",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("X-API-Key")).toBe(OPERATOR_KEY);
    expect(headers.get("X-Workspace-Ref")).toBe("workspace-1");
    expect(headers.get("X-Actor-Ref")).toBe("zernflow-operator");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("uses the administrator boundary only for takeover operations", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        conversation_id: "conversation-1",
        assignment_type: "human",
        assignee_ref: "operator-1",
        human_takeover: true,
        escalated: false,
        escalation_reason: null,
        updated_by_type: "operator",
        updated_by_ref: "zernflow",
        version: 1,
        updated_at: "2026-08-02T00:00:00Z",
      }),
    );
    const client = new HttpSocialGatewayClient({
      baseUrl: "https://gateway.example.test",
      operatorApiKey: OPERATOR_KEY,
      adminApiKey: ADMIN_KEY,
      fetchImpl: fetchMock as typeof fetch,
      production: true,
    });

    await client.setHumanTakeover("conversation-1", true, "Operator joined");

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Admin-API-Key")).toBe(ADMIN_KEY);
    expect(headers.has("X-API-Key")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      enabled: true,
      reason: "Operator joined",
    });
  });

  it("requires an individual agent credential for draft creation", async () => {
    const client = new HttpSocialGatewayClient({
      baseUrl: "https://gateway.example.test",
      operatorApiKey: OPERATOR_KEY,
      production: true,
    });

    await expect(
      client.createDraft("conversation-1", {
        text: "Draft response",
        idempotencyKey: "draft:conversation-1:1",
      }),
    ).rejects.toMatchObject({
      code: "social_gateway_not_configured",
    });
  });

  it("sends an agent bearer credential without the operator key", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "request-1",
        conversation_id: "conversation-1",
        requested_by_agent_id: "agent-1",
        workspace_ref: "default",
        action: "conversation.reply",
        text: "Draft response",
        reply_to_message_id: null,
        risk_level: "medium",
        status: "pending",
        idempotency_key: "draft:conversation-1:1",
        operation_id: null,
        reviewed_by_type: null,
        reviewed_by_ref: null,
        review_reason: null,
        created_at: "2026-08-02T00:00:00Z",
        updated_at: "2026-08-02T00:00:00Z",
        reviewed_at: null,
      }),
    );
    const client = new HttpSocialGatewayClient({
      baseUrl: "https://gateway.example.test",
      operatorApiKey: OPERATOR_KEY,
      agentCredential: AGENT_KEY,
      fetchImpl: fetchMock as typeof fetch,
      production: true,
    });

    await client.createDraft("conversation-1", {
      text: "Draft response",
      idempotencyKey: "draft:conversation-1:1",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${AGENT_KEY}`);
    expect(headers.has("X-API-Key")).toBe(false);
  });

  it("normalizes retryable gateway errors without returning raw response data", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          detail: {
            code: "credential_unavailable",
            message: "Provider credential is temporarily unavailable",
            raw_secret: "must-not-escape",
          },
        },
        503,
      ),
    );
    const client = new HttpSocialGatewayClient({
      baseUrl: "https://gateway.example.test",
      operatorApiKey: OPERATOR_KEY,
      fetchImpl: fetchMock as typeof fetch,
      production: true,
    });

    const error = await client.listAccounts().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SocialGatewayError);
    expect(error).toMatchObject({
      code: "credential_unavailable",
      message: "Provider credential is temporarily unavailable",
      status: 503,
      retryable: true,
    });
    expect(JSON.stringify(error)).not.toContain("raw_secret");
  });

  it("rejects insecure production endpoints and credentials embedded in URLs", () => {
    expect(
      () =>
        new HttpSocialGatewayClient({
          baseUrl: "http://gateway.example.test",
          operatorApiKey: OPERATOR_KEY,
          production: true,
        }),
    ).toThrow(SocialGatewayConfigurationError);

    expect(
      () =>
        new HttpSocialGatewayClient({
          baseUrl: "https://user:password@gateway.example.test",
          operatorApiKey: OPERATOR_KEY,
        }),
    ).toThrow(SocialGatewayConfigurationError);
  });
});

describe("HttpSocialGatewayClient Meta onboarding", () => {
  it("reads public provider readiness without sending credentials", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        provider: "meta",
        configured: true,
        application: "Temitayo Charlie Tech",
        platforms: ["facebook", "instagram"],
      }),
    );
    const client = new HttpSocialGatewayClient({
      baseUrl: "https://gateway.example.test",
      operatorApiKey: OPERATOR_KEY,
      fetchImpl: fetchMock as typeof fetch,
      production: true,
    });

    const readiness = await client.getProviderReadiness("meta");

    expect(readiness.configured).toBe(true);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(input.pathname).toBe("/v1/provider-readiness/meta");
    const headers = new Headers(init.headers);
    expect(headers.has("X-API-Key")).toBe(false);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("starts a Meta connection through the operator boundary", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        authUrl: "https://gateway.example.test/v1/connections/sessions/session-1/authorize?state=opaque",
        session_id: "session-1",
        expires_at: "2026-08-06T09:00:00Z",
      }),
    );
    const client = new HttpSocialGatewayClient({
      baseUrl: "https://gateway.example.test",
      operatorApiKey: OPERATOR_KEY,
      workspaceRef: "workspace-1",
      fetchImpl: fetchMock as typeof fetch,
      production: true,
    });

    await client.startConnection("instagram", {
      profileId: "workspace-1",
      redirectUrl: "https://app.zernflow.com/dashboard/channels/callback",
    });

    const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(input.pathname).toBe("/v1/connections/instagram");
    const headers = new Headers(init.headers);
    expect(headers.get("X-API-Key")).toBe(OPERATOR_KEY);
    expect(JSON.parse(String(init.body))).toEqual({
      profile_id: "workspace-1",
      redirect_url: "https://app.zernflow.com/dashboard/channels/callback",
    });
  });
});

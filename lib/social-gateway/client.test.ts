import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSocialGatewayHttpAdapter,
  createSocialGatewayClient,
  getSocialGatewayRuntimeStatus,
  ZernioCompatibilityAdapter,
} from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSocialGatewayRuntimeStatus", () => {
  it("reports a configured self-hosted gateway without exposing secrets", () => {
    expect(
      getSocialGatewayRuntimeStatus({
        SOCIAL_GATEWAY_DRIVER: "agent",
        SOCIAL_GATEWAY_BASE_URL: "https://gateway.example.test",
        SOCIAL_GATEWAY_API_KEY: "top-secret",
      }),
    ).toEqual({
      driver: "agent",
      configured: true,
      endpoint: "https://gateway.example.test",
    });
  });

  it("fails configuration status when either self-hosted value is absent", () => {
    expect(
      getSocialGatewayRuntimeStatus({
        SOCIAL_GATEWAY_DRIVER: "agent",
        SOCIAL_GATEWAY_BASE_URL: "https://gateway.example.test",
      }),
    ).toMatchObject({ driver: "agent", configured: false });
  });

  it("supports the temporary hosted compatibility driver", () => {
    expect(
      getSocialGatewayRuntimeStatus({
        SOCIAL_GATEWAY_DRIVER: "zernio",
        ZERNIO_API_KEY: "compat-key",
      }),
    ).toEqual({ driver: "zernio", configured: true });
  });
});

describe("createSocialGatewayClient", () => {
  it("builds the self-hosted HTTP adapter from runtime-managed values", () => {
    const client = createSocialGatewayClient({
      SOCIAL_GATEWAY_DRIVER: "agent",
      SOCIAL_GATEWAY_BASE_URL: "https://gateway.example.test/",
      SOCIAL_GATEWAY_API_KEY: "gateway-key",
    });
    expect(client).toBeInstanceOf(AgentSocialGatewayHttpAdapter);
  });

  it("builds the hosted compatibility adapter only when explicitly selected", () => {
    const client = createSocialGatewayClient({
      SOCIAL_GATEWAY_DRIVER: "zernio",
      ZERNIO_API_KEY: "compat-key",
    });
    expect(client).toBeInstanceOf(ZernioCompatibilityAdapter);
  });

  it("fails closed when self-hosted runtime credentials are absent", () => {
    expect(() => createSocialGatewayClient({ SOCIAL_GATEWAY_DRIVER: "agent" })).toThrow(
      "SOCIAL_GATEWAY_BASE_URL",
    );
  });
});

describe("AgentSocialGatewayHttpAdapter", () => {
  it("authenticates account listing with the runtime API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accounts: [{ _id: "account-1", platform: "telegram" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentSocialGatewayHttpAdapter({
      baseUrl: "https://gateway.example.test/",
      apiKey: "gateway-key",
    });
    const response = await client.accounts.list();

    expect(response.data?.accounts?.[0]).toMatchObject({ _id: "account-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.test/v1/accounts",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-API-Key": "gateway-key" }),
      }),
    );
  });

  it("returns structured gateway errors without leaking the API key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: { code: "not_configured" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const client = new AgentSocialGatewayHttpAdapter({
      baseUrl: "https://gateway.example.test",
      apiKey: "gateway-key",
    });
    const response = await client.profiles.list();

    expect(response.status).toBe(503);
    expect(response.error).toEqual({ detail: { code: "not_configured" } });
    expect(JSON.stringify(response)).not.toContain("gateway-key");
  });
});

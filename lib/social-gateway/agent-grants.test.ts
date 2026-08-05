import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAgentDraftGrants } from "./agent-grants";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("SOCIAL_GATEWAY_BASE_URL", "https://gateway.example.test");
  vi.stubEnv("SOCIAL_GATEWAY_ADMIN_API_KEY", "admin-key-with-at-least-24-chars");
  vi.stubEnv("SOCIAL_GATEWAY_AGENT_ID", "11111111-1111-4111-8111-111111111111");
  vi.stubEnv("SOCIAL_GATEWAY_WORKSPACE_REF", "zernflow");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ensureAgentDraftGrants", () => {
  it("does not require credentials when there are no provider accounts", async () => {
    vi.unstubAllEnvs();
    await expect(ensureAgentDraftGrants([])).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplicates provider accounts and preserves existing grants", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            grants: [
              {
                workspace_ref: "zernflow",
                provider_account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                action: "conversation.draft",
              },
              {
                workspace_ref: "another-workspace",
                provider_account_id: null,
                action: "conversation.read",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ grants: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await expect(
      ensureAgentDraftGrants([
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ]),
    ).resolves.toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(putInit.method).toBe("PUT");
    const body = JSON.parse(String(putInit.body));
    expect(body.grants).toHaveLength(3);
    expect(body.grants).toContainEqual({
      workspace_ref: "zernflow",
      provider_account_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      action: "conversation.draft",
    });
    expect(putInit.headers).toMatchObject({
      "X-Admin-Actor": "zernflow-channel-sync",
    });
  });

  it("does not replace grants when all required grants already exist", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          grants: [
            {
              workspace_ref: "zernflow",
              provider_account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              action: "conversation.draft",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      ensureAgentDraftGrants(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]),
    ).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

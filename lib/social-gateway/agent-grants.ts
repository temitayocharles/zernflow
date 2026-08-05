import "server-only";

type AgentGrant = {
  workspace_ref: string;
  provider_account_id: string;
  action: string;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for agent grant synchronization`);
  return value;
}

async function gatewayRequest(path: string, init: RequestInit = {}) {
  const baseUrl = requiredEnvironment("SOCIAL_GATEWAY_BASE_URL").replace(/\/$/, "");
  const adminKey = requiredEnvironment("SOCIAL_GATEWAY_ADMIN_API_KEY");
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Admin-API-Key": adminKey,
      "X-Admin-Actor": "zernflow-channel-sync",
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Gateway grant synchronization failed with HTTP ${response.status}`);
  }
  return response;
}

export async function ensureAgentDraftGrants(
  providerAccountIds: string[],
): Promise<number> {
  const uniqueAccountIds = [...new Set(providerAccountIds.filter(Boolean))];
  if (uniqueAccountIds.length === 0) return 0;

  const agentId = requiredEnvironment("SOCIAL_GATEWAY_AGENT_ID");
  const workspaceRef = requiredEnvironment("SOCIAL_GATEWAY_WORKSPACE_REF");
  const path = `/v1/admin/agents/${encodeURIComponent(agentId)}/grants`;
  const response = await gatewayRequest(path);
  const payload = (await response.json()) as { grants?: AgentGrant[] };
  const existing = payload.grants ?? [];
  const grants = [...existing];
  const keys = new Set(
    existing.map(
      (grant) =>
        `${grant.workspace_ref}:${grant.provider_account_id}:${grant.action}`,
    ),
  );

  let added = 0;
  for (const accountId of uniqueAccountIds) {
    const key = `${workspaceRef}:${accountId}:conversation.draft`;
    if (keys.has(key)) continue;
    grants.push({
      workspace_ref: workspaceRef,
      provider_account_id: accountId,
      action: "conversation.draft",
    });
    keys.add(key);
    added += 1;
  }

  if (added > 0) {
    await gatewayRequest(path, {
      method: "PUT",
      body: JSON.stringify({ grants }),
    });
  }

  return added;
}

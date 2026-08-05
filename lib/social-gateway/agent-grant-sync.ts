import "server-only";

import { ensureAgentDraftGrants } from "@/lib/social-gateway/agent-grants";

export type AgentDraftGrantStatus = {
  ready: boolean;
  grantsAdded: number;
  warning: null | {
    code: "agent_draft_grants_unavailable";
    message: string;
  };
};

export async function synchronizeAgentDraftGrants(
  providerAccountIds: string[],
  synchronize: (accountIds: string[]) => Promise<number> = ensureAgentDraftGrants,
): Promise<AgentDraftGrantStatus> {
  try {
    const grantsAdded = await synchronize(providerAccountIds);
    return { ready: true, grantsAdded, warning: null };
  } catch (error) {
    console.error("[channels/sync] agent draft grants unavailable", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return {
      ready: false,
      grantsAdded: 0,
      warning: {
        code: "agent_draft_grants_unavailable",
        message:
          "Channels synchronized, but autonomous draft generation remains unavailable until the agent credential is configured.",
      },
    };
  }
}

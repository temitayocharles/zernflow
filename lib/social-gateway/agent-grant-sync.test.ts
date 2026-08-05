import { describe, expect, it, vi } from "vitest";
import { synchronizeAgentDraftGrants } from "./agent-grant-sync";

describe("synchronizeAgentDraftGrants", () => {
  it("returns a ready capability when grant synchronization succeeds", async () => {
    const synchronize = vi.fn().mockResolvedValue(2);
    await expect(
      synchronizeAgentDraftGrants(["account-1", "account-2"], synchronize),
    ).resolves.toEqual({ ready: true, grantsAdded: 2, warning: null });
  });

  it("does not block channel synchronization when agent credentials are missing", async () => {
    const synchronize = vi.fn().mockRejectedValue(
      new Error("SOCIAL_GATEWAY_AGENT_ID is required"),
    );
    const result = await synchronizeAgentDraftGrants(["account-1"], synchronize);
    expect(result.ready).toBe(false);
    expect(result.grantsAdded).toBe(0);
    expect(result.warning?.code).toBe("agent_draft_grants_unavailable");
    expect(result.warning?.message).not.toContain("SOCIAL_GATEWAY_AGENT_ID");
  });
});

import { describe, expect, it } from "vitest";
import { createMemorySupabase } from "@/lib/test/memory-supabase";
import { scheduleFlowResume, type FlowResumePayload } from "./schedule-resume";

const payload: FlowResumePayload = {
  sessionId: "s1",
  nodeId: "delay-1",
  flowId: "f",
  channelId: "ch",
  contactId: "c",
  conversationId: "conv",
  workspaceId: "ws",
  lateConversationId: null,
  lateAccountId: null,
  variables: {},
};

describe("scheduleFlowResume", () => {
  it("uses the routing RPC and reports the accepting queue", async () => {
    const seen: unknown[] = [];
    const db = createMemorySupabase(
      { scheduled_jobs: [] },
      { rpc: { schedule_flow_resume: (args) => (seen.push(args), "tasks") } },
    );
    await expect(scheduleFlowResume(db.client as never, payload, "2030-01-01T00:00:00.000Z")).resolves.toBe("tasks");
    expect(seen).toEqual([{ p_payload: payload, p_run_at: "2030-01-01T00:00:00.000Z" }]);
    expect(db.tables.scheduled_jobs).toHaveLength(0);
  });

  it("falls back to the pre-R8 legacy insert when the RPC is not deployed", async () => {
    const db = createMemorySupabase({ scheduled_jobs: [] });
    await expect(scheduleFlowResume(db.client as never, payload, "2030-01-01T00:00:00.000Z")).resolves.toBe(
      "legacy_fallback",
    );
    expect(db.tables.scheduled_jobs).toEqual([
      expect.objectContaining({ type: "resume_flow", workspace_id: "ws", payload, run_at: "2030-01-01T00:00:00.000Z" }),
    ]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  schedules: vi.fn(),
  batch: vi.fn(),
  legacy: vi.fn(),
  sequences: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: async () => ({ rpc: m.rpc }) }));
vi.mock("@/lib/tasks/schedules", () => ({ materializeDueSchedules: m.schedules }));
vi.mock("@/lib/tasks/runner", () => ({ runTaskBatch: m.batch }));
vi.mock("@/lib/sequence-processor", () => ({ processSequenceSteps: m.sequences }));
vi.mock("../jobs/route", () => ({ GET: m.legacy }));

import { GET } from "./route";

const secret = "tick-secret-with-at-least-24-characters";
const authed = () =>
  new NextRequest("https://app.example/api/cron/tick", { headers: { authorization: `Bearer ${secret}` } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", secret);
  m.rpc.mockResolvedValue({ data: 2, error: null });
  m.schedules.mockResolvedValue({ due: 1, created: 1, errors: 0 });
  m.batch.mockResolvedValue({ claimed: 0, stoppedBy: "empty" });
  m.legacy.mockResolvedValue(Response.json({ processed: 0 }));
  m.sequences.mockResolvedValue({ processed: 0 });
});

describe("GET /api/cron/tick", () => {
  it("requires the cron bearer secret", async () => {
    expect((await GET(new NextRequest("https://app.example/api/cron/tick"))).status).toBe(401);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("runs every stage in order and reports each", async () => {
    const res = await GET(authed());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Object.keys(body.stages)).toEqual(["leaseRecovery", "schedules", "tasks", "legacyJobs", "sequences", "maintenance"]);
    expect(body.stages.leaseRecovery).toMatchObject({ status: "completed", recovered: 2 });
    expect(m.batch).toHaveBeenCalledWith(expect.objectContaining({ workerId: expect.stringMatching(/^tick:/) }));
  });
  it("isolates a failing stage and signals degradation", async () => {
    m.schedules.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(authed());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.failedStages).toEqual(["schedules"]);
    expect(body.stages.tasks.status).toBe("completed");
    expect(body.stages.legacyJobs.status).toBe("completed");
  });
});

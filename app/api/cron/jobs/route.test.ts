import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  rpc: vi.fn(),
  eq: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: mocks.client }));
vi.mock("@/lib/flow-engine/engine", () => ({
  FlowLoadError: class extends Error {},
  resumeSession: vi.fn(),
}));
vi.mock("@/lib/social-gateway/server", () => ({
  requireSocialGatewayClient: vi.fn(),
}));
vi.mock("@/lib/social-gateway/webhook-processor", () => ({
  processSocialGatewayWebhookEvent: vi.fn(),
}));
import { GET } from "./route";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  const prune = { eq: mocks.eq, lt: () => Promise.resolve({ error: null }) };
  mocks.eq.mockReturnValue(prune);
  const jobs = {
    or: () => jobs,
    lte: () => jobs,
    order: () => jobs,
    limit: () => Promise.resolve({ data: [], error: null }),
  };
  mocks.client.mockResolvedValue({
    from: (table: string) =>
      table === "webhook_events"
        ? { delete: () => prune }
        : { select: () => jobs },
    rpc: mocks.rpc,
  });
  mocks.rpc.mockResolvedValue({ data: 3, error: null });
});
afterEach(() => vi.unstubAllEnvs());
describe("existing cron SLA integration", () => {
  it("rejects unauthenticated scans before obtaining service access", async () => {
    expect(
      (await GET(new NextRequest("https://app.example/api/cron/jobs"))).status,
    ).toBe(401);
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("scans SLA even when no other jobs are pending and preserves durable Gateway events", async () => {
    const response = await GET(
      new NextRequest("https://app.example/api/cron/jobs", {
        headers: { Authorization: "Bearer test-cron-secret" },
      }),
    );
    expect(await response.json()).toMatchObject({
      processed: 0,
      total: 0,
      slaNotifications: { status: "completed", inserted: 3 },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("refresh_sla_notifications", {});
    expect(mocks.eq).toHaveBeenCalledWith("source", "zernio");
    expect(mocks.eq).toHaveBeenCalledWith("status", "completed");
  });
  it("surfaces failed SLA scan without falsifying other job outcomes", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "missing_function" },
    });
    const response = await GET(
      new NextRequest("https://app.example/api/cron/jobs", {
        headers: { Authorization: "Bearer test-cron-secret" },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      processed: 0,
      failed: 0,
      slaNotifications: { status: "failed" },
    });
  });
});

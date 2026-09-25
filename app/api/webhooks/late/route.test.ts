import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: mocks.client }));

import { POST } from "./route";
import { resetMetrics, snapshot } from "@/lib/observability/metrics";

afterEach(() => {
  vi.unstubAllEnvs();
  resetMetrics();
});

const request = () =>
  new NextRequest("http://localhost/api/webhooks/late", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });

describe("legacy Zernio webhook brownout", () => {
  it("answers 410 without touching the database when LEGACY_ZERNIO_WEBHOOK=reject", async () => {
    vi.stubEnv("LEGACY_ZERNIO_WEBHOOK", "reject");
    const res = await POST(request());
    expect(res.status).toBe(410);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot())).toMatch(/legacy_zernio_webhook_total.*rejected/);
  });

  it("still accepts (and counts) deliveries by default", async () => {
    mocks.client.mockRejectedValue(new Error("db unavailable in test"));
    const res = await POST(request());
    expect(res.status).not.toBe(410);
    expect(JSON.stringify(snapshot())).toMatch(/legacy_zernio_webhook_total.*accepted/);
  });
});

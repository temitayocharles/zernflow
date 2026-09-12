import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
}));

vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: mocks.updateSession,
}));

import { middleware } from "./middleware";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateSession.mockImplementation(async (request: NextRequest) =>
    NextResponse.json({
      authorization: request.headers.get("authorization"),
      cronSecret: request.headers.get("x-cron-secret"),
    }),
  );
});

describe("cron authentication middleware", () => {
  it("promotes X-Cron-Secret to the existing Bearer contract for cron routes", async () => {
    const response = await middleware(
      new NextRequest("https://app.example/api/cron/jobs", {
        headers: { "X-Cron-Secret": "test-cron-secret" },
      }),
    );

    expect(await response.json()).toMatchObject({
      authorization: "Bearer test-cron-secret",
      cronSecret: "test-cron-secret",
    });
  });

  it("does not overwrite an explicit Authorization header", async () => {
    const response = await middleware(
      new NextRequest("https://app.example/api/cron/sequences", {
        headers: {
          Authorization: "Bearer explicit-secret",
          "X-Cron-Secret": "fallback-secret",
        },
      }),
    );

    expect(await response.json()).toMatchObject({
      authorization: "Bearer explicit-secret",
      cronSecret: "fallback-secret",
    });
  });

  it("does not promote X-Cron-Secret outside cron routes", async () => {
    const response = await middleware(
      new NextRequest("https://app.example/api/v1/messages", {
        headers: { "X-Cron-Secret": "test-cron-secret" },
      }),
    );

    expect(await response.json()).toMatchObject({
      authorization: null,
      cronSecret: "test-cron-secret",
    });
  });
});

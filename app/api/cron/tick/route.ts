import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/security/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import { readBudget } from "@/lib/runtime/budget";
import { logger } from "@/lib/observability/log";
import { increment, observe } from "@/lib/observability/metrics";
import { materializeDueSchedules } from "@/lib/tasks/schedules";
import { runTaskBatch } from "@/lib/tasks/runner";
import { runMaintenance } from "@/lib/tasks/maintenance";
import "@/lib/tasks/sweeps";
import { processSequenceSteps } from "@/lib/sequence-processor";
import { GET as runLegacyJobs } from "../jobs/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StageResult = { status: "completed" | "failed" | "skipped"; durationMs: number; [key: string]: unknown };

async function stage(name: string, fn: () => Promise<Record<string, unknown>>): Promise<StageResult> {
  const started = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - started;
    observe("tick_stage_ms", durationMs, { stage: name });
    return { status: "completed", durationMs, ...result };
  } catch (error) {
    const durationMs = Date.now() - started;
    increment("tick_stage_failures", { stage: name });
    logger.error("tick.stage_failed", { operation: name, latencyMs: durationMs, error });
    return { status: "failed", durationMs, error: error instanceof Error ? error.name : "unknown" };
  }
}

/**
 * GET /api/cron/tick — the single maintenance entry point for the free cron
 * job (Authorization: Bearer <CRON_SECRET>). Stateless and safe to overlap:
 * claims use SKIP LOCKED leases and schedule materialization is CAS-guarded.
 *
 * Order: lease recovery → schedules → durable tasks → legacy scheduled_jobs
 * (flow resumes, broadcasts, Gateway events, SLA scan) → sequences →
 * maintenance. A failed stage never hides the others' results.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tickId = randomUUID();
  const budget = readBudget();
  const supabase = await createServiceClient();
  const started = Date.now();

  const stages: Record<string, StageResult> = {};
  stages.leaseRecovery = await stage("lease_recovery", async () => {
    const { data, error } = await supabase.rpc("recover_expired_leases");
    if (error) throw new Error(error.code ?? "rpc_failed");
    return { recovered: data ?? 0 };
  });
  stages.schedules = await stage("schedules", () => materializeDueSchedules(supabase));
  stages.tasks = await stage("tasks", async () => ({
    ...(await runTaskBatch({ supabase, workerId: `tick:${tickId}`, budget })),
  }));
  stages.legacyJobs = await stage("legacy_jobs", async () => {
    const response = await runLegacyJobs(request);
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(`legacy jobs returned ${response.status}`);
    return body;
  });
  stages.sequences = await stage("sequences", async () => ({ ...(await processSequenceSteps()) }));
  stages.maintenance = await stage("maintenance", () => runMaintenance(supabase, budget));

  const failed = Object.entries(stages)
    .filter(([, s]) => s.status === "failed")
    .map(([name]) => name);
  const durationMs = Date.now() - started;
  logger.info("tick.completed", { operation: "tick", tickId, latencyMs: durationMs, status: failed.length ? "degraded" : "ok" });
  // Heartbeat for System health (non-sensitive: status + stage names only). Never fails the tick.
  const { error: heartbeatError } = await supabase.rpc("record_heartbeat", {
    p_component: "tick",
    p_status: failed.length === 0 ? "ok" : failed.length === Object.keys(stages).length ? "failed" : "degraded",
    p_duration_ms: durationMs,
    p_detail: { failedStages: failed, tasksClaimed: Number((stages.tasks as { claimed?: number }).claimed ?? 0) },
  });
  if (heartbeatError) logger.warn("tick.heartbeat_failed", { operation: "tick", tickId, error: heartbeatError.code ?? "unknown" });
  return NextResponse.json(
    { tickId, ok: failed.length === 0, failedStages: failed, durationMs, stages },
    { status: failed.length ? 500 : 200, headers: { "Cache-Control": "no-store" } },
  );
}

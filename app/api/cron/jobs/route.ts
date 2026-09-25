import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/security/cron-auth";
import { createServiceClient } from "@/lib/supabase/server";
import {
  GatewayOperationPendingError,
  operationRetryDelayMs,
  processLegacyWork,
  SessionCancelError,
  SessionRecheckError,
  settleFailedWork,
  STALE_INVOCATION_MS,
} from "@/lib/jobs/legacy-work";
import type { Json } from "@/lib/types/database";

/**
 * Legacy scheduled_jobs drain (DEPRECATED producer target, R8).
 *
 * New work is routed per type by legacy_queue_routes (migration 00037) into
 * durable tasks once an operator flips the route; this drain keeps running so
 * rows queued before or after a flip always finish. Unit-of-work logic lives
 * in lib/jobs/legacy-work.ts and is shared with the task handlers.
 * Removal criteria: docs/architecture/LEGACY_JOBS_MIGRATION.md.
 *
 * Invoked by the cron tick (stage legacyJobs) or directly:
 * GET /api/cron/jobs with Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createServiceClient();

  // Prune the webhook idempotency ledger; ids only matter for Zernio's retry
  // window (hours). Never prune durable Gateway processing/failed records.
  await supabase
    .from("webhook_events")
    .delete()
    .eq("source", "zernio")
    .eq("status", "completed")
    .lt("received_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());

  // Pick up pending jobs that are due, plus 'processing' jobs whose claim is
  // stale: if the claim UPDATE commits but the response is lost, nothing else
  // ever re-reads that status and the job would be stranded forever. Five
  // minutes is far beyond any real processing time here. The is.null arm
  // covers rows claimed without a claimed_at stamp (strands from before
  // migration 00015's backfill, or claims by a not-yet-redeployed invocation
  // during a deploy; a lt. comparison is NULL-hostile and would skip them
  // forever). Those rows are NOT processed directly, only stamped, see below.
  const staleClaimCutoff = new Date(Date.now() - STALE_INVOCATION_MS).toISOString();
  const { data: jobs, error } = await supabase
    .from("scheduled_jobs")
    .select("*")
    .or(
      `status.eq.pending,and(status.eq.processing,or(claimed_at.lt.${staleClaimCutoff},claimed_at.is.null))`
    )
    .lte("run_at", new Date().toISOString())
    .order("run_at", { ascending: true })
    .limit(20);

  if (error || !jobs) {
    return NextResponse.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }

  let processed = 0;
  let failed = 0;
  const maxAttempts = 3;

  for (const job of jobs) {
    // A 'processing' row without claimed_at cannot be aged: it is either a
    // pre-backfill strand or a live claim by an old-code invocation that
    // never stamped claimed_at (deploy window). Processing it now could
    // double-process against that live invocation (duplicate sends), so just
    // start the staleness clock; the lt arm reclaims it next run once it is
    // provably stale.
    if (job.status === "processing" && !job.claimed_at) {
      const { error: stampError } = await supabase
        .from("scheduled_jobs")
        .update({ claimed_at: new Date().toISOString() })
        .eq("id", job.id)
        .eq("status", "processing")
        .is("claimed_at", null);
      if (stampError) {
        console.error(
          `Failed to stamp claimed_at on unaged job ${job.id}:`,
          stampError
        );
      }
      continue;
    }

    // A hung invocation (e.g. an httpRequest node on a never-responding
    // endpoint) never reaches the catch block, so the attempts cap there
    // cannot fire; without this guard the stale-claim reclaim would re-run
    // such a poison job forever, incrementing attempts unboundedly.
    if (job.attempts >= maxAttempts) {
      await failJobAndSettle({
        supabase,
        job,
        errorMessage: `Exceeded ${maxAttempts} attempts (stale claim reclaimed)`,
        onlyIfStuckOnDelayNode: true,
      });
      failed++;
      continue;
    }

    // Mark as processing; .select() returns the updated row so we can verify
    // the claim (overlapping cron runs would otherwise both process the job).
    // Matching attempts too makes this a CAS: once another run bumps attempts,
    // a stale snapshot can never re-claim the job, even after that run
    // requeues it as pending, so backoff and the attempt count are respected.
    const { data: claimed, error: claimError } = await supabase
      .from("scheduled_jobs")
      .update({
        status: "processing",
        attempts: job.attempts + 1,
        claimed_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", job.status) // Optimistic lock (pending, or stale-claim reclaim)
      .eq("attempts", job.attempts)
      .select();

    if (claimError) {
      // Unknown outcome: the UPDATE may have committed with only the response
      // lost. Skip; if it did commit, the stale-claim reclaim above picks the
      // job up again once claimed_at ages past the cutoff.
      console.error(`Failed to claim job ${job.id}:`, claimError);
      continue;
    }
    if (!claimed || claimed.length === 0) continue; // Claim lost to another run

    try {
      await processLegacyWork(supabase, job.type, job.payload, { queue: "scheduled_jobs", id: job.id });
      await supabase
        .from("scheduled_jobs")
        .update({ status: "completed" })
        .eq("id", job.id);
      processed++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (err instanceof GatewayOperationPendingError) {
        const payload =
          job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
            ? (job.payload as Record<string, Json>)
            : {};
        const rawChecks = payload.operationChecks;
        const operationChecks =
          typeof rawChecks === "number" && Number.isFinite(rawChecks)
            ? Math.max(0, Math.trunc(rawChecks)) + 1
            : 1;
        const retryDelayMs = operationRetryDelayMs(operationChecks);
        await supabase
          .from("scheduled_jobs")
          .update({
            status: "pending",
            run_at: new Date(Date.now() + retryDelayMs).toISOString(),
            attempts: job.attempts,
            last_error: errorMessage,
            payload: {
              ...payload,
              operationChecks,
              ...(err.operationId ? { operationId: err.operationId } : {}),
            } as unknown as Json,
          })
          .eq("id", job.id);
      } else if (err instanceof SessionRecheckError) {
        // Requeue past the recency window and undo the claim's attempts bump:
        // a recheck is not a failure, and letting rechecks exhaust attempts
        // would route a possibly-live session into the terminal cancel below.
        await supabase
          .from("scheduled_jobs")
          .update({
            status: "pending",
            run_at: new Date(Date.now() + STALE_INVOCATION_MS).toISOString(),
            attempts: job.attempts,
            last_error: errorMessage,
          })
          .eq("id", job.id);
      } else if (job.attempts + 1 >= maxAttempts || err instanceof SessionCancelError) {
        await failJobAndSettle({ supabase, job, errorMessage });
      } else {
        // Retry with backoff
        const backoffMs = Math.pow(2, job.attempts + 1) * 5000;
        const retryAt = new Date(Date.now() + backoffMs).toISOString();
        await supabase
          .from("scheduled_jobs")
          .update({
            status: "pending",
            run_at: retryAt,
            last_error: errorMessage,
          })
          .eq("id", job.id);
      }
      failed++;
    }
  }

  const sla = await supabase.rpc("refresh_sla_notifications", {});
  // Existing job outcomes remain accurate even if the separately retryable SLA
  // scan fails. Surface the degraded scan explicitly, without logging secrets.
  return NextResponse.json({ processed, failed, total: jobs.length,
    slaNotifications: sla.error
      ? { status: "failed", error: "SLA scan unavailable; verify migration 00028 and retry the cron invocation" }
      : { status: "completed", inserted: sla.data, mayHaveMore: (sla.data ?? 0) >= 1000 },
  }, { status: sla.error ? 503 : 200 });
}

// Marks a job out of retries as failed, then applies the shared settle side
// effects (session cancel, recipient/broadcast settle, webhook ledger).
async function failJobAndSettle({
  supabase,
  job,
  errorMessage,
  onlyIfStuckOnDelayNode = false,
}: {
  supabase: Awaited<ReturnType<typeof createServiceClient>>;
  job: { id: string; type: string; payload: Json };
  errorMessage: string;
  onlyIfStuckOnDelayNode?: boolean;
}) {
  await supabase
    .from("scheduled_jobs")
    .update({ status: "failed", last_error: errorMessage })
    .eq("id", job.id);
  await settleFailedWork({
    supabase,
    type: job.type,
    payload: job.payload,
    ref: { queue: "scheduled_jobs", id: job.id },
    errorMessage,
    onlyIfStuckOnDelayNode,
  });
}

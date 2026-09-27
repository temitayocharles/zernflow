import type { Json } from "@/lib/types/database";
import type { PublishReceiptRow } from "@/lib/types/platform";
import type { PublishState } from "@/lib/product/types";
import type { ServiceClient, TaskContext, TaskOutcome } from "@/lib/tasks/types";
import { TaskError, decisionFor } from "@/lib/tasks/errors";
import { normalizeRetryPolicy } from "@/lib/tasks/retry";
import {
  outcomeFromError,
  validateOutcome,
  type PublishOutcome,
  type PublishRequest,
  type PublishingProvider,
} from "./contract";

/**
 * Publishing engine (R10): the provider-independent half of an API-mode
 * publication. Given a provider and a request it
 *   - checks the provider capability for the platform/kind,
 *   - writes a receipt BEFORE calling the provider (so a crash mid-call is detectable),
 *   - polls accepted operations instead of resubmitting,
 *   - never resubmits an ambiguous attempt automatically unless the provider
 *     guarantees idempotent submits or an operator explicitly retried the job,
 *   - maps every outcome onto variant publish state + a classified task error.
 */

export const PUBLISH_POLL_STEP = "publish-op:";
export const MAX_ACCEPTED_AGE_MS = 24 * 3600_000;
export const MAX_POLLS = 200;
const MIN_POLL_MS = 15_000;
const MAX_POLL_MS = 10 * 60_000;

export interface EngineVariant {
  id: string;
  channel_id: string;
  publish_state: PublishState;
  attempt_count: number;
}

/** Legal variant transitions (mirror of variant_publish_guard in 00033). */
const LEGAL: Record<PublishState, readonly PublishState[]> = {
  draft: ["scheduled"],
  scheduled: ["draft", "queued", "publishing", "cancelled", "failed"],
  queued: ["draft", "publishing", "cancelled", "failed"],
  publishing: ["published", "failed", "queued", "cancelled"],
  published: [],
  failed: ["draft", "scheduled", "cancelled"],
  cancelled: ["draft", "scheduled"],
};

/** Shortest legal path from → to via scheduled/publishing only (never through draft/cancelled). */
export function publishPath(from: PublishState, to: PublishState): PublishState[] | null {
  if (from === to) return [];
  const queue: { s: PublishState; path: PublishState[] }[] = [{ s: from, path: [] }];
  const seen = new Set<PublishState>([from]);
  while (queue.length) {
    const { s, path } = queue.shift()!;
    for (const n of LEGAL[s]) {
      if (seen.has(n)) continue;
      const next = [...path, n];
      if (n === to) return next;
      if (n === "scheduled" || n === "publishing") {
        seen.add(n);
        queue.push({ s: n, path: next });
      }
    }
  }
  return null;
}

class VariantState {
  constructor(
    private readonly supabase: ServiceClient,
    private readonly workspaceId: string,
    readonly id: string,
    public state: PublishState,
  ) {}
  async moveTo(target: PublishState, patch: Record<string, unknown> = {}): Promise<void> {
    const path = publishPath(this.state, target);
    if (path === null) throw new TaskError("internal", `No legal publish transition ${this.state} -> ${target}`);
    const steps = path.length ? path : [target];
    for (let i = 0; i < steps.length; i++) {
      const last = i === steps.length - 1;
      const update = { ...(steps[i] !== this.state ? { publish_state: steps[i] } : {}), ...(last ? patch : {}) };
      if (!Object.keys(update).length) continue;
      const { error } = await this.supabase
        .from("editorial_variants")
        .update(update as never)
        .eq("workspace_id", this.workspaceId)
        .eq("id", this.id);
      if (error) throw new TaskError("internal", `variant update failed: ${error.code ?? "unknown"}`);
      this.state = steps[i];
    }
  }
}

type Receipts = Pick<
  PublishReceiptRow,
  "id" | "status" | "attempt" | "operation_ref" | "poll_count" | "created_at" | "external_ref" | "external_url" | "error_message"
>;
const RECEIPT_COLUMNS = "id, status, attempt, operation_ref, poll_count, created_at, external_ref, external_url, error_message";

export async function latestReceipt(supabase: ServiceClient, workspaceId: string, idempotencyKey: string): Promise<Receipts | null> {
  const { data, error } = await supabase
    .from("publish_receipts")
    .select(RECEIPT_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("idempotency_key", idempotencyKey)
    .order("attempt", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new TaskError("internal", `receipt lookup failed: ${error.code ?? "unknown"}`);
  return (data as Receipts | null) ?? null;
}

async function updateReceipt(supabase: ServiceClient, workspaceId: string, id: string, patch: Partial<PublishReceiptRow>) {
  const { error } = await supabase.from("publish_receipts").update(patch as never).eq("workspace_id", workspaceId).eq("id", id);
  if (error) throw new TaskError("internal", `receipt update failed: ${error.code ?? "unknown"}`);
}

/** Carries a non-success outcome through ctx.execute so the execution record gets the right status/class. */
class OutcomeCarrier extends TaskError {
  constructor(readonly outcome: PublishOutcome, cls: ConstructorParameters<typeof TaskError>[0], message: string) {
    super(cls, message);
  }
}

export function pollDelayMs(pollCount: number, hintMs?: number): number {
  const backoff = MIN_POLL_MS * 2 ** Math.min(pollCount, 6);
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, hintMs ?? 0, backoff));
}

export const AMBIGUOUS_MESSAGE =
  "A previous attempt may already have published this post. Check the platform: if it is live, unschedule this variant and record the link; if not, retry the job to resubmit.";

export async function runApiPublish(
  ctx: TaskContext,
  args: { provider: PublishingProvider; variant: EngineVariant; request: Omit<PublishRequest, "attempt">; platform: string },
): Promise<TaskOutcome> {
  const { task, supabase } = ctx;
  const { provider, request } = args;
  const ws = task.workspace_id;
  const variant = new VariantState(supabase, ws, args.variant.id, args.variant.publish_state);
  const maxAttempts = normalizeRetryPolicy(task.retry_policy).maxAttempts;

  // 1. Capability check (never execute an unverified route).
  const cap = provider.capability(request.platform, request.kind);
  if (cap.level !== "available") {
    await variant.moveTo("failed", { last_error: cap.reason.slice(0, 1000) });
    throw new TaskError("unsupported_capability", cap.reason);
  }

  const call = async (operation: string, fn: () => Promise<PublishOutcome>, ambiguousAsUnknown: boolean): Promise<PublishOutcome> => {
    try {
      const out = await ctx.execute({ provider: provider.id, operation, mode: "api", accountRef: request.channelId }, async () => {
        let o: PublishOutcome;
        try {
          o = validateOutcome(await fn());
        } catch (e) {
          o = outcomeFromError(e, !ambiguousAsUnknown || provider.idempotentSubmit);
        }
        if (o.status === "failed") throw new OutcomeCarrier(o, o.errorClass, o.message);
        if (o.status === "unknown") throw new OutcomeCarrier(o, "unknown_outcome", o.message);
        if (o.status === "partial") throw new OutcomeCarrier(o, "unknown_outcome", o.message);
        const meta: Record<string, Json> = { outcome: o.status };
        if (o.status === "accepted") meta.operationRef = o.operationRef;
        if (o.status === "published") meta.externalUrl = o.externalUrl;
        return { outcome: o, resultMeta: meta, externalRef: o.status === "published" ? o.externalRef : null };
      });
      return out.outcome;
    } catch (e) {
      if (e instanceof OutcomeCarrier) return e.outcome;
      return outcomeFromError(e, !ambiguousAsUnknown || provider.idempotentSubmit);
    }
  };

  // 2. Resume an accepted operation, or stop on an ambiguous previous attempt.
  const prior = await latestReceipt(supabase, ws, request.idempotencyKey);
  // A settled receipt whose variant update was lost (crash in between): finish it, never resubmit.
  if (prior?.status === "published") {
    await variant.moveTo("published", { external_ref: prior.external_ref, external_url: prior.external_url, last_error: null });
    return { status: "completed", result: { externalRef: prior.external_ref, externalUrl: prior.external_url, receiptId: prior.id, provider: provider.id, recovered: true } };
  }
  if (prior?.status === "partial") {
    const message = (prior.error_message ?? "Partially published; check the platform.").slice(0, 1000);
    await variant.moveTo("failed", { last_error: message });
    throw new TaskError("unknown_outcome", message, { terminal: true });
  }
  let receipt: Receipts;
  let outcome: PublishOutcome;
  if (prior?.status === "accepted" && prior.operation_ref && provider.status) {
    receipt = prior;
    const ref = prior.operation_ref;
    if (Date.now() - Date.parse(prior.created_at) > MAX_ACCEPTED_AGE_MS || prior.poll_count >= MAX_POLLS) {
      outcome = { status: "unknown", operationRef: ref, message: "The provider accepted this publication but never confirmed it within 24 hours." };
    } else {
      const polled = await call("publish_status", () => provider.status!(ref, AbortSignal.timeout(Math.max(5_000, ctx.deadline - Date.now()))), false);
      // A failed *status read* does not mean the publication failed.
      outcome =
        polled.status === "failed" && !polled.final && decisionFor(polled.errorClass) === "retry"
          ? { status: "accepted", operationRef: ref, pollAfterMs: polled.retryAfterMs }
          : polled;
    }
    receipt = { ...receipt, poll_count: prior.poll_count + 1 };
    await updateReceipt(supabase, ws, prior.id, { poll_count: receipt.poll_count });
  } else {
    const ambiguous =
      prior?.status === "submitting" ||
      (prior?.status === "accepted" && !provider.status) ||
      (prior?.status === "unknown" && task.human_intervention !== "resolved") ||
      (!prior && args.variant.publish_state === "publishing");
    if (ambiguous && !provider.idempotentSubmit) {
      if (prior && prior.status !== "unknown") {
        await updateReceipt(supabase, ws, prior.id, { status: "unknown", error_class: "unknown_outcome", error_message: "Attempt ended without a recorded provider answer." });
      }
      await variant.moveTo("failed", { last_error: AMBIGUOUS_MESSAGE });
      throw new TaskError("unknown_outcome", AMBIGUOUS_MESSAGE);
    }

    // 3. Submit: receipt first, then the provider call.
    await variant.moveTo("publishing", { attempt_count: args.variant.attempt_count + 1, last_error: null });
    const attempt = Math.max(task.attempts, (prior?.attempt ?? 0) + 1);
    const { data: inserted, error } = await supabase
      .from("publish_receipts")
      .insert({
        workspace_id: ws,
        variant_id: variant.id,
        task_id: task.id,
        idempotency_key: request.idempotencyKey,
        attempt,
        mode: "api",
        provider: provider.id,
        status: "submitting",
      })
      .select(RECEIPT_COLUMNS)
      .single();
    if (error || !inserted) {
      // A concurrent executor already owns this attempt; do not double-submit.
      throw new TaskError(error?.code === "23505" ? "unknown_outcome" : "internal", `could not record publish attempt: ${error?.code ?? "no row"}`);
    }
    receipt = inserted as Receipts;
    outcome = await call(
      "publish_post",
      () => provider.submit({ ...request, attempt }, AbortSignal.timeout(Math.max(5_000, ctx.deadline - Date.now()))),
      true,
    );
  }

  // 4. Apply the outcome.
  switch (outcome.status) {
    case "published": {
      await updateReceipt(supabase, ws, receipt.id, {
        status: "published",
        external_ref: outcome.externalRef,
        external_url: outcome.externalUrl,
        parts: (outcome.parts ?? []) as unknown as Json,
        error_class: null,
        error_message: null,
      });
      await variant.moveTo("published", { external_ref: outcome.externalRef, external_url: outcome.externalUrl, last_error: null });
      await ctx.event("info", "Published", { provider: provider.id, receiptId: receipt.id, externalRef: outcome.externalRef });
      return { status: "completed", result: { externalRef: outcome.externalRef, externalUrl: outcome.externalUrl, receiptId: receipt.id, provider: provider.id } };
    }
    case "accepted": {
      await updateReceipt(supabase, ws, receipt.id, {
        status: "accepted",
        ...(receipt.operation_ref ? {} : { operation_ref: outcome.operationRef }),
      });
      if (variant.state !== "publishing") await variant.moveTo("publishing");
      const delay = pollDelayMs(receipt.poll_count, outcome.pollAfterMs);
      if (!prior || prior.id !== receipt.id) {
        await ctx.event("info", "Accepted by provider; waiting for confirmation", { provider: provider.id, operationRef: outcome.operationRef });
      }
      return { status: "deferred", nextRunAt: new Date(Date.now() + delay), step: `${PUBLISH_POLL_STEP}${receipt.id}` };
    }
    case "partial": {
      const live = outcome.parts.filter((p) => p.status === "published").length;
      const message = `Partially published (${live} of ${outcome.parts.length} parts live): ${outcome.message} Check the platform; ZernFlow will not resubmit automatically because that would duplicate the live parts.`.slice(0, 1000);
      await updateReceipt(supabase, ws, receipt.id, {
        status: "partial",
        external_ref: outcome.externalRef,
        external_url: outcome.externalUrl,
        parts: outcome.parts as unknown as Json,
        error_class: "unknown_outcome",
        error_message: message,
      });
      await variant.moveTo("failed", { last_error: message });
      throw new TaskError("unknown_outcome", message, { terminal: true });
    }
    case "failed": {
      await updateReceipt(supabase, ws, receipt.id, {
        status: "failed",
        error_class: outcome.errorClass,
        error_code: outcome.code ?? null,
        error_message: outcome.message.slice(0, 1000),
      });
      const willRetry = !outcome.final && decisionFor(outcome.errorClass) === "retry" && task.attempts < maxAttempts;
      await variant.moveTo(willRetry ? "queued" : "failed", { last_error: outcome.message.slice(0, 1000) });
      throw new TaskError(outcome.errorClass, outcome.message, { retryAfterMs: outcome.retryAfterMs, terminal: outcome.final });
    }
    case "unknown": {
      await updateReceipt(supabase, ws, receipt.id, {
        status: "unknown",
        ...(outcome.operationRef && !receipt.operation_ref ? { operation_ref: outcome.operationRef } : {}),
        error_class: "unknown_outcome",
        error_message: outcome.message.slice(0, 1000),
      });
      const message = `${outcome.message} ${AMBIGUOUS_MESSAGE}`.slice(0, 1000);
      await variant.moveTo("failed", { last_error: message });
      throw new TaskError("unknown_outcome", message);
    }
  }
}

/** Receipt for a remote (browser) worker outcome. Best-effort: never blocks settlement. */
export async function recordRemoteReceipt(
  supabase: ServiceClient,
  input: {
    workspaceId: string;
    variantId: string;
    taskId: string;
    idempotencyKey: string;
    attempt: number;
    provider: string;
    status: "published" | "failed" | "unknown";
    externalRef?: string | null;
    externalUrl?: string | null;
    errorClass?: PublishReceiptRow["error_class"] | null;
    message?: string | null;
  },
): Promise<void> {
  await supabase.from("publish_receipts").insert({
    workspace_id: input.workspaceId,
    variant_id: input.variantId,
    task_id: input.taskId,
    idempotency_key: input.idempotencyKey,
    attempt: Math.max(1, input.attempt),
    mode: "browser",
    provider: input.provider.slice(0, 64),
    status: input.status,
    external_ref: input.externalRef?.slice(0, 300) ?? null,
    external_url: input.externalUrl ?? null,
    error_class: input.errorClass ?? null,
    error_message: input.message?.slice(0, 1000) ?? null,
  });
}

from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one marker, found {count}")
    path.write_text(text.replace(old, new, 1))


database = Path("lib/types/database.ts")
replace_once(
    database,
    'export type SequenceEnrollmentStatus = "active" | "completed" | "cancelled";\n',
    'export type SequenceEnrollmentStatus =\n  | "active"\n  | "completed"\n  | "cancelled"\n  | "failed";\n',
)
replace_once(
    database,
    '''          next_step_at: string | null;
          completed_at: string | null;
        };
        Insert: {
''',
    '''          next_step_at: string | null;
          completed_at: string | null;
          current_operation_id: string | null;
          operation_checks: number;
          last_error: string | null;
        };
        Insert: {
''',
)
replace_once(
    database,
    '''          next_step_at?: string | null;
          completed_at?: string | null;
        };
        Update: {
          current_step_index?: number;
          status?: SequenceEnrollmentStatus;
          next_step_at?: string | null;
          completed_at?: string | null;
        };
''',
    '''          next_step_at?: string | null;
          completed_at?: string | null;
          current_operation_id?: string | null;
          operation_checks?: number;
          last_error?: string | null;
        };
        Update: {
          current_step_index?: number;
          status?: SequenceEnrollmentStatus;
          next_step_at?: string | null;
          completed_at?: string | null;
          current_operation_id?: string | null;
          operation_checks?: number;
          last_error?: string | null;
        };
''',
)

Path("lib/sequence-processor.ts").write_text('''import {
  SocialGatewayError,
} from "@/lib/social-gateway/client";
import { requireSocialGatewayClient } from "@/lib/social-gateway/server";
import { createServiceClient } from "@/lib/supabase/server";
import type { SequenceStep } from "@/lib/types/database";

const OPERATION_CHECK_BASE_MS = 5_000;
const OPERATION_CHECK_MAX_MS = 5 * 60 * 1000;
const TRANSIENT_RETRY_MS = 30_000;

type SupabaseServiceClient = Awaited<ReturnType<typeof createServiceClient>>;
type EnrollmentResult = "advanced" | "waiting" | "failed" | "cancelled";

interface SequenceEnrollment {
  id: string;
  sequence_id: string;
  contact_id: string;
  channel_id: string;
  current_step_index: number;
  current_operation_id: string | null;
  operation_checks: number;
  last_error: string | null;
  sequences: {
    id: string;
    workspace_id: string;
    steps: unknown;
    status: string;
  } | null;
}

export async function processSequenceSteps() {
  const supabase = await createServiceClient();
  const { data: enrollments, error } = await supabase
    .from("sequence_enrollments")
    .select("*, sequences(*)")
    .eq("status", "active")
    .lte("next_step_at", new Date().toISOString())
    .order("next_step_at", { ascending: true })
    .limit(50);

  if (error || !enrollments) {
    console.error("[sequences] failed to fetch due enrollments", {
      error: error?.message ?? "No enrollment data returned",
    });
    return { processed: 0, waiting: 0, failed: 0, total: 0 };
  }

  let processed = 0;
  let waiting = 0;
  let failed = 0;

  for (const enrollment of enrollments as SequenceEnrollment[]) {
    try {
      const result = await processEnrollment(supabase, enrollment);
      if (result === "advanced" || result === "cancelled") processed += 1;
      if (result === "waiting") waiting += 1;
      if (result === "failed") failed += 1;
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 1_000) : "Unknown sequence error";
      console.error("[sequences] enrollment processing failed", {
        enrollmentId: enrollment.id,
        error: message,
      });
      await supabase
        .from("sequence_enrollments")
        .update({
          last_error: message,
          next_step_at: new Date(Date.now() + TRANSIENT_RETRY_MS).toISOString(),
        })
        .eq("id", enrollment.id)
        .eq("status", "active")
        .eq("current_step_index", enrollment.current_step_index);
      failed += 1;
    }
  }

  return { processed, waiting, failed, total: enrollments.length };
}

async function processEnrollment(
  supabase: SupabaseServiceClient,
  enrollment: SequenceEnrollment,
): Promise<EnrollmentResult> {
  const sequence = enrollment.sequences;
  if (!sequence) {
    await supabase
      .from("sequence_enrollments")
      .update({
        status: "cancelled",
        next_step_at: null,
        current_operation_id: null,
        operation_checks: 0,
        last_error: "Sequence no longer exists",
      })
      .eq("id", enrollment.id)
      .eq("status", "active");
    return "cancelled";
  }
  if (sequence.status !== "active") {
    await supabase
      .from("sequence_enrollments")
      .update({
        next_step_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        last_error: `Sequence is ${sequence.status}`,
      })
      .eq("id", enrollment.id)
      .eq("status", "active");
    return "waiting";
  }

  const steps = (sequence.steps as SequenceStep[]) ?? [];
  const stepIndex = enrollment.current_step_index;
  if (stepIndex >= steps.length) {
    await completeEnrollment(supabase, enrollment.id, stepIndex);
    return "advanced";
  }

  const currentStep = steps[stepIndex];
  if (currentStep.type === "message") {
    const outcome = await settleMessageStep(
      supabase,
      enrollment,
      sequence.workspace_id,
      currentStep.content ?? "",
    );
    if (outcome !== "succeeded") return outcome;
  }

  await advanceEnrollment(supabase, enrollment, steps);
  return "advanced";
}

async function settleMessageStep(
  supabase: SupabaseServiceClient,
  enrollment: SequenceEnrollment,
  workspaceId: string,
  rawText: string,
): Promise<"succeeded" | "waiting" | "failed"> {
  const text = rawText.trim();
  if (!text || text.length > 4_096) {
    await failEnrollment(
      supabase,
      enrollment,
      text ? "Sequence message exceeds 4096 characters" : "Sequence message is empty",
    );
    return "failed";
  }

  const gateway = requireSocialGatewayClient();
  let operationId = enrollment.current_operation_id;

  try {
    let operation;
    if (operationId) {
      operation = await gateway.getOperation(operationId);
    } else {
      const { data: conversation, error } = await supabase
        .from("conversations")
        .select("late_conversation_id")
        .eq("workspace_id", workspaceId)
        .eq("contact_id", enrollment.contact_id)
        .eq("channel_id", enrollment.channel_id)
        .single();
      if (error || !conversation?.late_conversation_id) {
        await failEnrollment(
          supabase,
          enrollment,
          error?.message ?? "Agent Social Gateway conversation is not projected",
        );
        return "failed";
      }

      operation = await gateway.replyToConversation(
        conversation.late_conversation_id,
        {
          text,
          idempotencyKey: `zernflow:sequence:${enrollment.id}:${enrollment.current_step_index}`,
        },
      );
      operationId = operation.id;
      const { error: persistError } = await supabase
        .from("sequence_enrollments")
        .update({
          current_operation_id: operation.id,
          operation_checks: 0,
          last_error: null,
        })
        .eq("id", enrollment.id)
        .eq("status", "active")
        .eq("current_step_index", enrollment.current_step_index);
      if (persistError) throw new Error(persistError.message);
    }

    if (operation.status === "succeeded") {
      await supabase.from("analytics_events").insert({
        workspace_id: workspaceId,
        contact_id: enrollment.contact_id,
        event_type: "message_sent",
        metadata: {
          delivery: "durable_gateway_operation",
          source: "sequence",
          sequence_id: enrollment.sequence_id,
          enrollment_id: enrollment.id,
          step_index: enrollment.current_step_index,
          operation_id: operation.id,
        },
      });
      return "succeeded";
    }

    if (operation.status === "pending" || operation.status === "running") {
      await scheduleOperationCheck(supabase, enrollment, operation.id, operation.status);
      return "waiting";
    }

    if (operation.status === "failed" && operation.retryable) {
      const retried = await gateway.retryOperation(operation.id);
      await scheduleOperationCheck(supabase, enrollment, retried.id, "retry_queued");
      return "waiting";
    }

    await failEnrollment(
      supabase,
      { ...enrollment, current_operation_id: operation.id },
      operation.error_message ??
        (operation.status === "unknown"
          ? "Sequence delivery outcome is unknown and requires review"
          : "Agent Social Gateway sequence operation failed"),
    );
    return "failed";
  } catch (error) {
    if (error instanceof SocialGatewayError && error.retryable) {
      await scheduleOperationCheck(
        supabase,
        enrollment,
        operationId,
        error.message,
        TRANSIENT_RETRY_MS,
      );
      return "waiting";
    }
    await failEnrollment(
      supabase,
      { ...enrollment, current_operation_id: operationId },
      error instanceof Error ? error.message : "Sequence delivery failed",
    );
    return "failed";
  }
}

async function scheduleOperationCheck(
  supabase: SupabaseServiceClient,
  enrollment: SequenceEnrollment,
  operationId: string | null,
  reason: string,
  fixedDelayMs?: number,
): Promise<void> {
  const checks = enrollment.operation_checks + 1;
  const delayMs =
    fixedDelayMs ??
    Math.min(
      OPERATION_CHECK_BASE_MS * 2 ** Math.min(checks - 1, 6),
      OPERATION_CHECK_MAX_MS,
    );
  const { error } = await supabase
    .from("sequence_enrollments")
    .update({
      current_operation_id: operationId,
      operation_checks: checks,
      last_error: reason.slice(0, 1_000),
      next_step_at: new Date(Date.now() + delayMs).toISOString(),
    })
    .eq("id", enrollment.id)
    .eq("status", "active")
    .eq("current_step_index", enrollment.current_step_index);
  if (error) throw new Error(error.message);
}

async function failEnrollment(
  supabase: SupabaseServiceClient,
  enrollment: SequenceEnrollment,
  message: string,
): Promise<void> {
  const { error } = await supabase
    .from("sequence_enrollments")
    .update({
      status: "failed",
      next_step_at: null,
      current_operation_id: enrollment.current_operation_id,
      last_error: message.slice(0, 1_000),
    })
    .eq("id", enrollment.id)
    .eq("status", "active")
    .eq("current_step_index", enrollment.current_step_index);
  if (error) throw new Error(error.message);
}

async function completeEnrollment(
  supabase: SupabaseServiceClient,
  enrollmentId: string,
  expectedStepIndex: number,
): Promise<void> {
  const { error } = await supabase
    .from("sequence_enrollments")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      next_step_at: null,
      current_operation_id: null,
      operation_checks: 0,
      last_error: null,
    })
    .eq("id", enrollmentId)
    .eq("status", "active")
    .eq("current_step_index", expectedStepIndex);
  if (error) throw new Error(error.message);
}

async function advanceEnrollment(
  supabase: SupabaseServiceClient,
  enrollment: SequenceEnrollment,
  steps: SequenceStep[],
): Promise<void> {
  const nextIndex = enrollment.current_step_index + 1;
  if (nextIndex >= steps.length) {
    const { error } = await supabase
      .from("sequence_enrollments")
      .update({
        current_step_index: nextIndex,
        status: "completed",
        completed_at: new Date().toISOString(),
        next_step_at: null,
        current_operation_id: null,
        operation_checks: 0,
        last_error: null,
      })
      .eq("id", enrollment.id)
      .eq("status", "active")
      .eq("current_step_index", enrollment.current_step_index);
    if (error) throw new Error(error.message);
    return;
  }

  const nextStep = steps[nextIndex];
  const nextStepAt =
    nextStep.type === "delay" && nextStep.delayMinutes
      ? new Date(Date.now() + nextStep.delayMinutes * 60 * 1000).toISOString()
      : new Date().toISOString();
  const { error } = await supabase
    .from("sequence_enrollments")
    .update({
      current_step_index: nextIndex,
      next_step_at: nextStepAt,
      current_operation_id: null,
      operation_checks: 0,
      last_error: null,
    })
    .eq("id", enrollment.id)
    .eq("status", "active")
    .eq("current_step_index", enrollment.current_step_index);
  if (error) throw new Error(error.message);
}
''')

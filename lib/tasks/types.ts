import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/types/database";
import type { ExecutionMode, TaskRow } from "@/lib/types/platform";
import type { RuntimeBudget } from "@/lib/runtime/budget";

export type ServiceClient = SupabaseClient<Database>;

export type TaskOutcome =
  | { status: "completed"; result?: Json }
  | { status: "deferred"; nextRunAt: Date; step?: string };

export interface ExecutionInput {
  provider: string;
  operation: string;
  mode: "internal" | "api" | "browser";
  accountRef?: string | null;
}

export interface ExecutionOutput {
  resultMeta?: Record<string, Json>;
  externalRef?: string | null;
  artifactIds?: string[];
}

export interface TaskContext {
  task: TaskRow;
  supabase: ServiceClient;
  budget: RuntimeBudget;
  /** Epoch ms after which handlers should stop starting new external work. */
  deadline: number;
  event(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, Json>): Promise<void>;
  /** Wraps one external attempt in an execution record (latency, status, error class). */
  execute<T extends ExecutionOutput>(input: ExecutionInput, fn: () => Promise<T>): Promise<T>;
}

export interface TaskHandler<I extends Record<string, unknown> = Record<string, unknown>> {
  kind: string;
  title: string;
  description: string;
  /** Where the task executes. internal/api run inside the tick; browser runs on remote executors. */
  mode: ExecutionMode;
  /** May be attached to a recurring schedule. */
  schedulable: boolean;
  /** Owners may start it manually from the Jobs page. */
  userRunnable: boolean;
  parseInput(input: unknown): I;
  run?(ctx: TaskContext, input: I): Promise<TaskOutcome>;
}

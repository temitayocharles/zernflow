import type { RuntimeBudget } from "@/lib/runtime/budget";
import type { ServiceClient } from "./types";

export type MaintenanceSweep = {
  name: string;
  run(supabase: ServiceClient, budget: RuntimeBudget): Promise<Record<string, unknown>>;
};

const sweeps: MaintenanceSweep[] = [];

/** Deployment-wide sweeps (artifact retention, session expiry) register here. */
export function registerSweep(sweep: MaintenanceSweep): void {
  if (!sweeps.some((s) => s.name === sweep.name)) sweeps.push(sweep);
}

export async function runMaintenance(supabase: ServiceClient, budget: RuntimeBudget) {
  const results: Record<string, unknown> = {};
  for (const sweep of sweeps) {
    try {
      results[sweep.name] = await sweep.run(supabase, budget);
    } catch (error) {
      results[sweep.name] = { status: "failed", error: error instanceof Error ? error.name : "unknown" };
    }
  }
  return { sweeps: results };
}

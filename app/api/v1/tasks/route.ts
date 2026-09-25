import { randomUUID } from "node:crypto";
import { ApiError, databaseError, failure, json, productContext, readJson } from "@/lib/product/api";
import { object } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { getHandler } from "@/lib/tasks/handlers";
import { enqueueTask } from "@/lib/tasks/enqueue";
import { recordAudit } from "@/lib/audit";
import { TASK_STATES, type TaskState } from "@/lib/types/platform";
import type { Json } from "@/lib/types/database";

const VIEWS: Record<string, readonly TaskState[]> = {
  attention: ["waiting_for_user"],
  active: ["queued", "running", "waiting", "retrying"],
  failed: ["failed"],
  completed: ["completed"],
  cancelled: ["cancelled"],
};

export async function GET(request: Request) {
  try {
    const { supabase, workspaceId } = await productContext();
    const url = new URL(request.url);
    const view = url.searchParams.get("view") ?? "all";
    const state = url.searchParams.get("state");
    const kind = url.searchParams.get("kind");
    const page = Math.max(0, Math.min(1000, Number(url.searchParams.get("page")) || 0));
    let query = supabase
      .from("tasks")
      .select(
        "id, kind, objective, state, execution_mode, attempts, next_run_at, approval_state, human_intervention, intervention_reason, error, campaign_id, created_at, updated_at, finished_at, dead_lettered_at",
        { count: "exact" },
      )
      .eq("workspace_id", workspaceId);
    if (state && (TASK_STATES as readonly string[]).includes(state)) query = query.eq("state", state as TaskState);
    else if (view === "approvals") query = query.eq("approval_state", "pending").not("state", "in", "(completed,failed,cancelled)");
    else if (VIEWS[view]) query = query.in("state", [...VIEWS[view]]);
    if (kind && /^[a-z0-9_.]{1,100}$/.test(kind)) query = query.eq("kind", kind);
    const { data, error, count } = await query
      .order("created_at", { ascending: false })
      .order("id")
      .range(page * 50, page * 50 + 49);
    databaseError(error);
    return json({ tasks: data ?? [], total: count ?? 0, page });
  } catch (error) {
    return failure(error);
  }
}

/** POST /api/v1/tasks { kind, input? } — owners start a user-runnable task now. */
export async function POST(request: Request) {
  try {
    const { workspaceId, role, user } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Workspace owner access required");
    const body = object(await readJson(request));
    const handler = typeof body.kind === "string" ? getHandler(body.kind) : undefined;
    if (!handler || !handler.userRunnable) throw new ApiError(400, "This task kind cannot be started manually");
    const input = handler.parseInput(body.input ?? {});
    const service = await createServiceClient();
    const task = await enqueueTask(service, {
      workspaceId,
      kind: handler.kind,
      objective: `${handler.title} (manual)`,
      idempotencyKey: `manual:${handler.kind}:${randomUUID()}`,
      input: input as Record<string, Json>,
      executionMode: handler.mode,
      createdBy: user.id,
    });
    await recordAudit(service, {
      workspaceId,
      entityType: "task",
      entityId: task.id,
      actorId: user.id,
      action: "task.created",
      changes: { kind: handler.kind },
    });
    return json({ id: task.id }, 201);
  } catch (error) {
    return failure(error);
  }
}

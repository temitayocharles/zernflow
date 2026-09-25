import { ApiError, databaseError, failure, json, productContext, readJson } from "@/lib/product/api";
import { createServiceClient } from "@/lib/supabase/server";
import { parseScheduleInput } from "@/lib/tasks/schedule-input";
import { recordAudit } from "@/lib/audit";

export async function GET() {
  try {
    const { supabase, workspaceId } = await productContext();
    const { data, error } = await supabase
      .from("task_schedules")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(200);
    databaseError(error);
    return json({ schedules: data ?? [] });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const { workspaceId, role, user } = await productContext();
    if (role !== "owner") throw new ApiError(403, "Workspace owner access required");
    const draft = parseScheduleInput(await readJson(request, 32_768));
    const service = await createServiceClient();
    const { data, error } = await service
      .from("task_schedules")
      .insert({ ...draft, workspace_id: workspaceId, created_by: user.id })
      .select("*")
      .single();
    databaseError(error);
    await recordAudit(service, {
      workspaceId,
      entityType: "task_schedule",
      entityId: data!.id,
      actorId: user.id,
      action: "schedule.created",
      changes: { kind: draft.kind, cron: draft.cron, intervalSeconds: draft.interval_seconds, timezone: draft.timezone },
    });
    return json({ schedule: data }, 201);
  } catch (error) {
    return failure(error);
  }
}

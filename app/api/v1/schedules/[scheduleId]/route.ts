import { ApiError, databaseError, failure, json, productContext, readJson } from "@/lib/product/api";
import { object, uuid } from "@/lib/product/validation";
import { createServiceClient } from "@/lib/supabase/server";
import { parseScheduleInput } from "@/lib/tasks/schedule-input";
import { recordAudit } from "@/lib/audit";

async function ownerSchedule(scheduleId: string) {
  const { workspaceId, role, user } = await productContext();
  if (role !== "owner") throw new ApiError(403, "Workspace owner access required");
  const service = await createServiceClient();
  const { data, error } = await service
    .from("task_schedules")
    .select("*")
    .eq("id", scheduleId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  databaseError(error);
  if (!data) throw new ApiError(404, "Schedule not found");
  return { service, workspaceId, user, schedule: data };
}

/** PATCH { enabled } toggles; any other field set replaces the definition (re-validated). */
export async function PATCH(request: Request, { params }: { params: Promise<{ scheduleId: string }> }) {
  try {
    const id = uuid((await params).scheduleId, "schedule id");
    const { service, workspaceId, user, schedule } = await ownerSchedule(id);
    const body = object(await readJson(request, 32_768));
    const keys = Object.keys(body);
    let update: Record<string, unknown>;
    if (keys.length === 1 && keys[0] === "enabled") {
      if (typeof body.enabled !== "boolean") throw new ApiError(400, "enabled must be boolean");
      update = { enabled: body.enabled };
      if (body.enabled && !schedule.enabled) {
        update.next_run_at = parseScheduleInput({
          name: schedule.name,
          kind: schedule.kind,
          input: schedule.input,
          cron: schedule.cron,
          intervalSeconds: schedule.interval_seconds,
          timezone: schedule.timezone,
        }).next_run_at;
      }
    } else {
      update = { ...parseScheduleInput({ kind: schedule.kind, name: schedule.name, ...body }) };
    }
    const { data, error } = await service
      .from("task_schedules")
      .update(update)
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .select("*")
      .single();
    databaseError(error);
    await recordAudit(service, {
      workspaceId,
      entityType: "task_schedule",
      entityId: id,
      actorId: user.id,
      action: "schedule.updated",
      changes: { fields: Object.keys(update) },
    });
    return json({ schedule: data });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ scheduleId: string }> }) {
  try {
    const id = uuid((await params).scheduleId, "schedule id");
    const { service, workspaceId, user } = await ownerSchedule(id);
    const { error } = await service.from("task_schedules").delete().eq("id", id).eq("workspace_id", workspaceId);
    databaseError(error);
    await recordAudit(service, {
      workspaceId,
      entityType: "task_schedule",
      entityId: id,
      actorId: user.id,
      action: "schedule.deleted",
    });
    return json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}

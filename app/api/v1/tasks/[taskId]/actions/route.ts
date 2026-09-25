import { ApiError, failure, json, productContext, readJson } from "@/lib/product/api";
import { choice, object, text, uuid } from "@/lib/product/validation";

/** POST { action: approve|reject|cancel|retry, note? } — enforced by membership-checked RPCs. */
export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const taskId = uuid((await params).taskId, "task id");
    const { supabase } = await productContext();
    const body = object(await readJson(request, 8192));
    const action = choice(body.action, "action", ["approve", "reject", "cancel", "retry"]);
    const note = body.note === undefined ? null : text(body.note, "note", 500);
    const call =
      action === "approve" || action === "reject"
        ? supabase.rpc("approve_task", { p_task: taskId, p_approve: action === "approve", p_note: note })
        : action === "cancel"
          ? supabase.rpc("cancel_task", { p_task: taskId, p_reason: note })
          : supabase.rpc("retry_task", { p_task: taskId, p_note: note });
    const { data, error } = await call;
    if (error) {
      if (error.code === "42501") throw new ApiError(error.message.includes("owner") ? 403 : 404, error.message.includes("owner") ? "Workspace owner access required" : "Task not found");
      if (error.code === "23514") throw new ApiError(409, "The task is not in a state that allows this action");
      throw new ApiError(503, "Task action unavailable. Confirm migration 00031 is applied.");
    }
    return json({ ok: true, result: data });
  } catch (error) {
    return failure(error);
  }
}

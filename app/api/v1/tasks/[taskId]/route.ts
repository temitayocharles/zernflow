import { ApiError, databaseError, failure, json, productContext } from "@/lib/product/api";
import { uuid } from "@/lib/product/validation";

export async function GET(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  try {
    const taskId = uuid((await params).taskId, "task id");
    const { supabase, workspaceId } = await productContext();
    const { data: task, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", taskId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    databaseError(error);
    if (!task) throw new ApiError(404, "Task not found");
    const [{ data: events }, { data: executions }] = await Promise.all([
      supabase
        .from("task_events")
        .select("id, level, message, data, actor_id, created_at")
        .eq("task_id", taskId)
        .eq("workspace_id", workspaceId)
        .order("created_at")
        .limit(500),
      supabase
        .from("execution_records")
        .select("*")
        .eq("task_id", taskId)
        .eq("workspace_id", workspaceId)
        .order("started_at", { ascending: false })
        .limit(100),
    ]);
    return json({ task, events: events ?? [], executions: executions ?? [] });
  } catch (error) {
    return failure(error);
  }
}

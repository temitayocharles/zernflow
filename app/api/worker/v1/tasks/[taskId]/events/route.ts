import type { Json } from "@/lib/types/database";
import { choice, text } from "@/lib/product/validation";
import { redact, redactString } from "@/lib/observability/log";
import { readWorkerJson, workerJson, workerRoute } from "@/lib/workers/api";
import { leasedTask } from "@/lib/workers/lease";

export const runtime = "nodejs";

/** Append a redacted log line to the task timeline (lease required). */
export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  return workerRoute(request, async (ctx) => {
    const task = await leasedTask(ctx, (await params).taskId);
    const body = await readWorkerJson(request, 16_384);
    const level = choice(body.level ?? "info", "level", ["debug", "info", "warn", "error"]);
    const message = redactString(text(body.message, "message", 1000, true));
    const data = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? redact(body.data) : {};
    await ctx.supabase.rpc("task_log", {
      p_workspace: task.workspace_id,
      p_task: task.id,
      p_level: level,
      p_message: message,
      p_data: data as Json,
    });
    return workerJson({ ok: true });
  });
}

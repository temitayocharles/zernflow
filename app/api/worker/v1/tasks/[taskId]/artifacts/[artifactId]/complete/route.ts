import { workerJson, workerRoute, WorkerApiError } from "@/lib/workers/api";
import { leasedTask } from "@/lib/workers/lease";
import { uuid } from "@/lib/product/validation";
import { getObjectStore } from "@/lib/storage";
import { ArtifactError, completeUpload } from "@/lib/artifacts/service";
import { artifactStatus } from "@/lib/artifacts/http";

export const runtime = "nodejs";

/** POST → verify an artifact this worker uploaded for its leased task. */
export async function POST(request: Request, { params }: { params: Promise<{ taskId: string; artifactId: string }> }) {
  return workerRoute(request, async (ctx) => {
    const p = await params;
    const task = await leasedTask(ctx, p.taskId);
    const artifactId = uuid(p.artifactId, "artifact id");
    try {
      const artifact = await completeUpload(ctx.supabase, getObjectStore(), {
        workspaceId: task.workspace_id,
        artifactId,
        actor: { type: "worker", id: ctx.identity.id },
        restrictToWorker: ctx.identity.id,
        restrictToTask: task.id,
      });
      return workerJson({ artifactId, status: artifact.status }, artifact.status === "available" ? 200 : 422);
    } catch (err) {
      if (err instanceof ArtifactError) throw new WorkerApiError(artifactStatus(err), err.message, `artifact_${err.code}`);
      throw err;
    }
  });
}

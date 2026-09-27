import { readWorkerJson, workerJson, workerRoute, WorkerApiError } from "@/lib/workers/api";
import { leasedTask } from "@/lib/workers/lease";
import { getObjectStore } from "@/lib/storage";
import { readBudget } from "@/lib/runtime/budget";
import { ArtifactError, createUpload } from "@/lib/artifacts/service";
import { ALL_KINDS, WORKER_UPLOAD_KINDS } from "@/lib/artifacts/policy";
import { artifactStatus } from "@/lib/artifacts/http";
import type { ArtifactKind } from "@/lib/types/platform";

export const runtime = "nodejs";

/** POST { kind, fileName, contentType, sizeBytes, sha256 } → presigned PUT bound to the leased task. */
export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  return workerRoute(request, async (ctx) => {
    const task = await leasedTask(ctx, (await params).taskId);
    const body = await readWorkerJson(request, 8192);
    const kind = String(body.kind ?? "");
    if (!ALL_KINDS.includes(kind as ArtifactKind)) throw new WorkerApiError(400, "Invalid kind", "invalid_request");
    try {
      const result = await createUpload(ctx.supabase, getObjectStore(), readBudget(), {
        workspaceId: task.workspace_id,
        kind: kind as ArtifactKind,
        allowedKinds: WORKER_UPLOAD_KINDS,
        fileName: String(body.fileName ?? kind).slice(0, 255),
        contentType: String(body.contentType ?? ""),
        sizeBytes: Number(body.sizeBytes),
        sha256: String(body.sha256 ?? ""),
        taskId: task.id,
        actor: { type: "worker", id: ctx.identity.id },
        metadata: { correlationId: task.correlation_id, attempt: task.attempts },
      });
      return workerJson({ artifactId: result.artifact.id, upload: result.upload }, 201);
    } catch (err) {
      if (err instanceof ArtifactError) throw new WorkerApiError(artifactStatus(err), err.message, `artifact_${err.code}`);
      throw err;
    }
  });
}

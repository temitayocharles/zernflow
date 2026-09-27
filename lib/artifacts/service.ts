import "server-only";
import { randomUUID } from "node:crypto";
import type { Json } from "@/lib/types/database";
import type { ArtifactKind, ArtifactRow } from "@/lib/types/platform";
import type { ServiceClient } from "@/lib/tasks/types";
import type { RuntimeBudget } from "@/lib/runtime/budget";
import { clampExpiry, type ObjectStore, type PresignedUpload } from "@/lib/storage/object-store";
import { recordAudit } from "@/lib/audit";
import {
  contentDisposition,
  EPHEMERAL_KINDS,
  magicMatches,
  mimeAllowed,
  normalizeContentType,
  sanitizeFileName,
} from "./policy";

/**
 * Artifact lifecycle (ARTIFACT_STORAGE_DESIGN.md). Object keys are generated
 * server-side under the workspace prefix; every read/write resolves the row by
 * (workspace_id, id) first, so objects of another tenant are unreachable.
 */
export class ArtifactError extends Error {
  constructor(
    readonly code: "invalid" | "too_large" | "quota" | "not_found" | "conflict" | "not_ready",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

export const ARTIFACT_COLUMNS =
  "id, workspace_id, kind, object_key, file_name, content_type, size_bytes, sha256, status, retention_until, campaign_id, task_id, execution_record_id, metadata, created_by, created_by_worker, created_at, updated_at, completed_at, deleted_at";

export type ArtifactActor = { type: "user"; id: string } | { type: "worker"; id: string } | { type: "system"; id: string };

export function objectKeyFor(workspaceId: string, kind: ArtifactKind, id: string, now: Date): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `ws/${workspaceId}/${kind}/${yyyy}/${mm}/${id}`;
}

async function workspaceUsage(service: ServiceClient, workspaceId: string): Promise<number> {
  const { data, error } = await service
    .from("artifacts")
    .select("size_bytes")
    .eq("workspace_id", workspaceId)
    .in("status", ["pending_upload", "available", "quarantined"]);
  if (error) throw new Error(`usage lookup failed: ${error.code ?? "unknown"}`);
  return (data ?? []).reduce((sum, r) => sum + Number(r.size_bytes), 0);
}

export interface CreateUploadInput {
  workspaceId: string;
  kind: ArtifactKind;
  allowedKinds: readonly ArtifactKind[];
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  actor: ArtifactActor;
  taskId?: string | null;
  campaignId?: string | null;
  metadata?: Record<string, Json>;
}

export async function createUpload(
  service: ServiceClient,
  store: ObjectStore,
  budget: RuntimeBudget,
  input: CreateUploadInput,
  now = new Date(),
): Promise<{ artifact: ArtifactRow; upload: PresignedUpload }> {
  if (!input.allowedKinds.includes(input.kind)) throw new ArtifactError("invalid", `Kind ${input.kind} cannot be uploaded here`);
  const contentType = normalizeContentType(input.contentType);
  if (!mimeAllowed(input.kind, contentType)) throw new ArtifactError("invalid", `Content type ${contentType} is not allowed for ${input.kind}`);
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new ArtifactError("invalid", "sizeBytes must be a positive integer");
  if (input.sizeBytes > budget.maxUploadSizeBytes) throw new ArtifactError("too_large", `File exceeds the ${budget.maxUploadSizeBytes}-byte upload limit`);
  const sha256 = input.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ArtifactError("invalid", "sha256 must be 64 hex characters");
  const used = await workspaceUsage(service, input.workspaceId);
  if (used + input.sizeBytes > budget.maxWorkspaceStorageBytes) {
    throw new ArtifactError("quota", "Workspace storage limit reached. Delete assets or raise MAX_WORKSPACE_STORAGE_BYTES within your free tier.");
  }

  const id = randomUUID();
  const objectKey = objectKeyFor(input.workspaceId, input.kind, id, now);
  const retentionUntil = EPHEMERAL_KINDS.includes(input.kind)
    ? new Date(now.getTime() + budget.maxArtifactRetentionDays * 86400_000).toISOString()
    : null;

  const { data, error } = await service
    .from("artifacts")
    .insert({
      id,
      workspace_id: input.workspaceId,
      kind: input.kind,
      object_key: objectKey,
      file_name: sanitizeFileName(input.fileName),
      content_type: contentType,
      size_bytes: input.sizeBytes,
      sha256,
      status: "pending_upload",
      retention_until: retentionUntil,
      task_id: input.taskId ?? null,
      campaign_id: input.campaignId ?? null,
      metadata: input.metadata ?? {},
      created_by: input.actor.type === "user" ? input.actor.id : null,
      created_by_worker: input.actor.type === "worker" ? input.actor.id : null,
    })
    .select(ARTIFACT_COLUMNS)
    .single();
  if (error || !data) {
    if (error?.code === "23503") throw new ArtifactError("invalid", "Linked task or campaign does not belong to this workspace");
    throw new Error(`artifact insert failed: ${error?.code ?? "unknown"}`);
  }
  const upload = await store.presignPut(objectKey, { contentType, sizeBytes: input.sizeBytes, sha256Hex: sha256, expiresInSeconds: 900 });
  return { artifact: data as ArtifactRow, upload };
}

async function loadArtifact(service: ServiceClient, workspaceId: string, id: string): Promise<ArtifactRow> {
  const { data, error } = await service.from("artifacts").select(ARTIFACT_COLUMNS).eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (error) throw new Error(`artifact lookup failed: ${error.code ?? "unknown"}`);
  if (!data) throw new ArtifactError("not_found", "Artifact not found");
  return data as ArtifactRow;
}

/**
 * Verifies the uploaded object (size, content type, checksum when reported,
 * magic bytes) and marks it available, or quarantines it on mismatch.
 */
export async function completeUpload(
  service: ServiceClient,
  store: ObjectStore,
  input: { workspaceId: string; artifactId: string; actor: ArtifactActor; restrictToWorker?: string; restrictToTask?: string },
): Promise<ArtifactRow> {
  const artifact = await loadArtifact(service, input.workspaceId, input.artifactId);
  if (input.restrictToWorker && artifact.created_by_worker !== input.restrictToWorker) throw new ArtifactError("not_found", "Artifact not found");
  if (input.restrictToTask && artifact.task_id !== input.restrictToTask) throw new ArtifactError("not_found", "Artifact not found");
  if (artifact.status === "available") return artifact;
  if (artifact.status !== "pending_upload") throw new ArtifactError("conflict", `Artifact is ${artifact.status}`);

  const head = await store.headObject(artifact.object_key);
  if (!head) throw new ArtifactError("not_ready", "Upload not found in storage yet");

  const problems: string[] = [];
  if (head.sizeBytes !== Number(artifact.size_bytes)) problems.push("size_mismatch");
  if (head.contentType && normalizeContentType(head.contentType) !== artifact.content_type) problems.push("content_type_mismatch");
  if (head.checksumSha256 && head.checksumSha256 !== Buffer.from(artifact.sha256, "hex").toString("base64")) problems.push("checksum_mismatch");
  if (problems.length === 0) {
    const head4k = await store.getRange(artifact.object_key, 0, 4095);
    if (!head4k || !magicMatches(artifact.content_type, head4k)) problems.push("content_signature_mismatch");
  }

  const nowIso = new Date().toISOString();
  const status = problems.length ? "quarantined" : "available";
  const meta = artifact.metadata && typeof artifact.metadata === "object" && !Array.isArray(artifact.metadata) ? artifact.metadata : {};
  const { data, error } = await service
    .from("artifacts")
    .update({
      status,
      completed_at: nowIso,
      metadata: { ...meta, verification: { checksumVerified: Boolean(head.checksumSha256), problems } },
      // Quarantined objects are removed by the retention sweep after 7 days.
      ...(problems.length ? { retention_until: new Date(Date.now() + 7 * 86400_000).toISOString() } : {}),
    })
    .eq("id", artifact.id)
    .eq("workspace_id", input.workspaceId)
    .eq("status", "pending_upload")
    .select(ARTIFACT_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`artifact update failed: ${error.code ?? "unknown"}`);
  if (!data) return loadArtifact(service, input.workspaceId, artifact.id);
  await recordAudit(service, {
    workspaceId: input.workspaceId,
    entityType: "artifact",
    entityId: artifact.id,
    actorId: input.actor.type === "user" ? input.actor.id : null,
    action: problems.length ? "artifact.quarantined" : "artifact.uploaded",
    changes: { kind: artifact.kind, sizeBytes: artifact.size_bytes, problems, actor: `${input.actor.type}:${input.actor.id}` },
  });
  return data as ArtifactRow;
}

export async function signedDownload(
  service: ServiceClient,
  store: ObjectStore,
  input: { workspaceId: string; artifactId: string; expiresInSeconds?: number },
): Promise<{ url: string; expiresAt: string; artifact: ArtifactRow }> {
  const artifact = await loadArtifact(service, input.workspaceId, input.artifactId);
  if (artifact.status !== "available") throw new ArtifactError("not_ready", `Artifact is ${artifact.status}`);
  const ttl = clampExpiry(input.expiresInSeconds);
  const url = await store.presignGet(artifact.object_key, {
    expiresInSeconds: ttl,
    contentType: artifact.content_type,
    disposition: contentDisposition(artifact.content_type, artifact.file_name || "file"),
  });
  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), artifact };
}

export async function deleteArtifact(
  service: ServiceClient,
  store: ObjectStore,
  input: { workspaceId: string; artifactId: string; actor: ArtifactActor },
): Promise<void> {
  const artifact = await loadArtifact(service, input.workspaceId, input.artifactId);
  if (artifact.status === "deleted") return;
  await store.deleteObject(artifact.object_key);
  const { error } = await service
    .from("artifacts")
    .update({ status: "deleted", deleted_at: new Date().toISOString() })
    .eq("id", artifact.id)
    .eq("workspace_id", input.workspaceId);
  if (error) throw new Error(`artifact delete failed: ${error.code ?? "unknown"}`);
  await recordAudit(service, {
    workspaceId: input.workspaceId,
    entityType: "artifact",
    entityId: artifact.id,
    actorId: input.actor.type === "user" ? input.actor.id : null,
    action: "artifact.deleted",
    changes: { kind: artifact.kind, fileName: artifact.file_name },
  });
}

/**
 * Retention sweep (bounded): expired execution artifacts and quarantined
 * objects, plus uploads abandoned for more than 24 hours.
 */
export async function sweepArtifacts(service: ServiceClient, store: ObjectStore, now = new Date(), limit = 50) {
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - 86400_000).toISOString();
  const [expired, abandoned] = await Promise.all([
    service.from("artifacts").select("id, workspace_id, object_key").neq("status", "deleted").lte("retention_until", nowIso).limit(limit),
    service.from("artifacts").select("id, workspace_id, object_key").eq("status", "pending_upload").lte("created_at", staleIso).limit(limit),
  ]);
  if (expired.error || abandoned.error) throw new Error("artifact sweep scan failed");
  const seen = new Set<string>();
  let deleted = 0;
  let failed = 0;
  for (const row of [...(expired.data ?? []), ...(abandoned.data ?? [])]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    try {
      await store.deleteObject(row.object_key);
      await service.from("artifacts").update({ status: "deleted", deleted_at: nowIso }).eq("id", row.id).eq("workspace_id", row.workspace_id);
      deleted++;
    } catch {
      failed++;
    }
  }
  return { deleted, failed };
}

import "server-only";
import { ApiError, failure } from "@/lib/product/api";
import { InputError } from "@/lib/product/validation";
import { StorageNotConfiguredError } from "@/lib/storage/object-store";
import { ArtifactError } from "./service";

export function artifactStatus(error: ArtifactError): number {
  return { invalid: 400, too_large: 413, quota: 507, not_found: 404, conflict: 409, not_ready: 409 }[error.code];
}

export function artifactFailure(error: unknown) {
  if (error instanceof ArtifactError) return failure(new ApiError(artifactStatus(error), error.message));
  if (error instanceof StorageNotConfiguredError) {
    return failure(new ApiError(503, "Artifact storage is not configured on this deployment (ARTIFACT_S3_*)."));
  }
  if (error instanceof InputError) return failure(error);
  return failure(error);
}

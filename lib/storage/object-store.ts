import "server-only";

/**
 * Vendor-neutral object storage (docs/architecture/ARTIFACT_STORAGE_DESIGN.md).
 * Only the S3 protocol is used, so AWS S3, Cloudflare R2, Backblaze B2 or a
 * self-hosted MinIO/Garage on K3s are interchangeable by configuration.
 */
export interface HeadResult {
  sizeBytes: number;
  contentType: string | null;
  /** base64 SHA-256 when the provider reports checksums, else null. */
  checksumSha256: string | null;
}

export interface PresignedUpload {
  url: string;
  method: "PUT";
  /** Headers the client MUST send exactly (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface ObjectStore {
  readonly name: string;
  putObject(key: string, body: Uint8Array, opts: { contentType: string; sha256Hex?: string }): Promise<void>;
  headObject(key: string): Promise<HeadResult | null>;
  /** Inclusive byte range; used to sniff magic bytes without downloading whole objects. */
  getRange(key: string, start: number, end: number): Promise<Uint8Array | null>;
  deleteObject(key: string): Promise<void>;
  presignPut(key: string, opts: { contentType: string; sizeBytes: number; sha256Hex: string; expiresInSeconds: number }): Promise<PresignedUpload>;
  presignGet(key: string, opts: { expiresInSeconds: number; contentType: string; disposition: string }): Promise<string>;
}

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Artifact storage is not configured (ARTIFACT_S3_* variables)");
    this.name = "StorageNotConfiguredError";
  }
}

export function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

export const PRESIGN_MIN_SECONDS = 30;
export const PRESIGN_MAX_SECONDS = 3600;
export const PRESIGN_DEFAULT_SECONDS = 300;

export function clampExpiry(seconds: number | undefined): number {
  const s = Math.floor(seconds ?? PRESIGN_DEFAULT_SECONDS);
  return Math.min(PRESIGN_MAX_SECONDS, Math.max(PRESIGN_MIN_SECONDS, Number.isFinite(s) ? s : PRESIGN_DEFAULT_SECONDS));
}

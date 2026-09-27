import "server-only";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { hexToBase64, type HeadResult, type ObjectStore, type PresignedUpload } from "./object-store";

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  sse: "AES256" | "aws:kms" | "none";
  /** Sign x-amz-checksum-sha256 into uploads (provider verifies the bytes). */
  checksum: boolean;
}

type Env = Record<string, string | undefined>;

export function readS3Config(env: Env = process.env): S3Config | null {
  const bucket = env.ARTIFACT_S3_BUCKET?.trim();
  const accessKeyId = env.ARTIFACT_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.ARTIFACT_S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const endpoint = env.ARTIFACT_S3_ENDPOINT?.trim() || undefined;
  if (endpoint) {
    const url = new URL(endpoint);
    const internal = ["localhost", "127.0.0.1", "minio", "garage"].includes(url.hostname) || url.hostname.endsWith(".svc") || url.hostname.endsWith(".internal");
    if (url.protocol !== "https:" && !internal) throw new Error("ARTIFACT_S3_ENDPOINT must use https outside local/cluster-internal hosts");
  }
  const sse = (env.ARTIFACT_S3_SSE?.trim() || "AES256") as S3Config["sse"];
  if (!["AES256", "aws:kms", "none"].includes(sse)) throw new Error("ARTIFACT_S3_SSE must be AES256, aws:kms or none");
  return {
    endpoint,
    region: env.ARTIFACT_S3_REGION?.trim() || "auto",
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env.ARTIFACT_S3_FORCE_PATH_STYLE === "true",
    sse,
    checksum: env.ARTIFACT_S3_CHECKSUM !== "none",
  };
}

export class S3ObjectStore implements ObjectStore {
  readonly name = "s3";
  readonly #client: S3Client;
  readonly #cfg: S3Config;

  constructor(cfg: S3Config, client?: S3Client) {
    this.#cfg = cfg;
    this.#client =
      client ??
      new S3Client({
        endpoint: cfg.endpoint,
        region: cfg.region,
        forcePathStyle: cfg.forcePathStyle,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
        // Keep presigned URLs portable across S3-compatible providers.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
  }

  #sse(): { ServerSideEncryption?: ServerSideEncryption } {
    return this.#cfg.sse === "none" ? {} : { ServerSideEncryption: this.#cfg.sse };
  }

  async putObject(key: string, body: Uint8Array, opts: { contentType: string; sha256Hex?: string }) {
    const sha = opts.sha256Hex ?? createHash("sha256").update(body).digest("hex");
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#cfg.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        ContentLength: body.byteLength,
        ...(this.#cfg.checksum ? { ChecksumSHA256: hexToBase64(sha) } : {}),
        ...this.#sse(),
      }),
    );
  }

  async headObject(key: string): Promise<HeadResult | null> {
    try {
      const res = await this.#client.send(new HeadObjectCommand({ Bucket: this.#cfg.bucket, Key: key, ChecksumMode: "ENABLED" }));
      return {
        sizeBytes: Number(res.ContentLength ?? 0),
        contentType: res.ContentType ?? null,
        checksumSha256: res.ChecksumSHA256?.split("-")[0] ?? null,
      };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === "NotFound") return null;
      throw err;
    }
  }

  async getRange(key: string, start: number, end: number): Promise<Uint8Array | null> {
    try {
      const res = await this.#client.send(new GetObjectCommand({ Bucket: this.#cfg.bucket, Key: key, Range: `bytes=${start}-${end}` }));
      return res.Body ? await res.Body.transformToByteArray() : null;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || status === 416) return null;
      throw err;
    }
  }

  async deleteObject(key: string) {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#cfg.bucket, Key: key }));
  }

  async presignPut(key: string, opts: { contentType: string; sizeBytes: number; sha256Hex: string; expiresInSeconds: number }): Promise<PresignedUpload> {
    const checksum = hexToBase64(opts.sha256Hex);
    const command = new PutObjectCommand({
      Bucket: this.#cfg.bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.sizeBytes,
      ...(this.#cfg.checksum ? { ChecksumSHA256: checksum } : {}),
      ...this.#sse(),
    });
    const signed = new Set(["content-type", "content-length"]);
    const unhoist = new Set<string>();
    if (this.#cfg.checksum) {
      signed.add("x-amz-checksum-sha256");
      unhoist.add("x-amz-checksum-sha256");
    }
    if (this.#cfg.sse !== "none") {
      signed.add("x-amz-server-side-encryption");
      unhoist.add("x-amz-server-side-encryption");
    }
    const url = await getSignedUrl(this.#client, command, {
      expiresIn: opts.expiresInSeconds,
      signableHeaders: signed,
      unhoistableHeaders: unhoist,
    });
    const headers: Record<string, string> = { "Content-Type": opts.contentType };
    if (this.#cfg.checksum) headers["x-amz-checksum-sha256"] = checksum;
    if (this.#cfg.sse !== "none") headers["x-amz-server-side-encryption"] = this.#cfg.sse;
    return { url, method: "PUT", headers, expiresAt: new Date(Date.now() + opts.expiresInSeconds * 1000).toISOString() };
  }

  async presignGet(key: string, opts: { expiresInSeconds: number; contentType: string; disposition: string }) {
    return getSignedUrl(
      this.#client,
      new GetObjectCommand({
        Bucket: this.#cfg.bucket,
        Key: key,
        ResponseContentType: opts.contentType,
        ResponseContentDisposition: opts.disposition,
        ResponseCacheControl: "private, max-age=300",
      }),
      { expiresIn: opts.expiresInSeconds },
    );
  }
}

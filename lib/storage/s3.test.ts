import { describe, expect, it } from "vitest";
import { readS3Config, S3ObjectStore } from "./s3";

const env = {
  ARTIFACT_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  ARTIFACT_S3_BUCKET: "zernflow",
  ARTIFACT_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
  ARTIFACT_S3_SECRET_ACCESS_KEY: "secret",
  ARTIFACT_S3_FORCE_PATH_STYLE: "true",
};

describe("S3 object store", () => {
  it("reads vendor-neutral configuration and refuses insecure endpoints", () => {
    expect(readS3Config({})).toBeNull();
    expect(readS3Config(env)).toMatchObject({ region: "auto", sse: "AES256", checksum: true, forcePathStyle: true });
    expect(() => readS3Config({ ...env, ARTIFACT_S3_ENDPOINT: "http://files.example.com" })).toThrow(/https/);
    expect(readS3Config({ ...env, ARTIFACT_S3_ENDPOINT: "http://minio:9000" })?.endpoint).toBe("http://minio:9000");
    expect(() => readS3Config({ ...env, ARTIFACT_S3_SSE: "bogus" })).toThrow(/SSE/);
  });

  it("presigns uploads that bind content type, length, checksum and encryption as signed headers", async () => {
    const store = new S3ObjectStore(readS3Config(env)!);
    const sha = "a".repeat(64);
    const up = await store.presignPut("ws/w/image/2026/09/id", { contentType: "image/png", sizeBytes: 123, sha256Hex: sha, expiresInSeconds: 900 });
    const url = new URL(up.url);
    expect(url.pathname).toBe("/zernflow/ws/w/image/2026/09/id");
    const signed = url.searchParams.get("X-Amz-SignedHeaders")!.split(";");
    expect(signed).toEqual(expect.arrayContaining(["content-type", "content-length", "host", "x-amz-checksum-sha256", "x-amz-server-side-encryption"]));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(up.headers).toMatchObject({ "Content-Type": "image/png", "x-amz-checksum-sha256": Buffer.from(sha, "hex").toString("base64"), "x-amz-server-side-encryption": "AES256" });
    expect(url.search).not.toContain("secret");
  });

  it("presigns downloads with forced content type and disposition", async () => {
    const store = new S3ObjectStore(readS3Config({ ...env, ARTIFACT_S3_SSE: "none", ARTIFACT_S3_CHECKSUM: "none" })!);
    const url = new URL(await store.presignGet("k", { expiresInSeconds: 60, contentType: "application/pdf", disposition: 'attachment; filename="a.pdf"' }));
    expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(url.searchParams.get("response-content-disposition")).toContain("attachment");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
  });
});

import { createHash } from "node:crypto";
import type { HeadResult, ObjectStore, PresignedUpload } from "./object-store";

/** In-memory ObjectStore for tests. `simulateUpload` plays the client's presigned PUT. */
export class MemoryObjectStore implements ObjectStore {
  readonly name = "memory";
  readonly objects = new Map<string, { body: Uint8Array; contentType: string; sha256: string }>();
  readonly presigned = new Map<string, { contentType: string; sizeBytes: number; sha256Hex: string }>();

  async putObject(key: string, body: Uint8Array, opts: { contentType: string; sha256Hex?: string }) {
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (opts.sha256Hex && opts.sha256Hex !== sha256) throw new Error("BadDigest");
    this.objects.set(key, { body, contentType: opts.contentType, sha256 });
  }

  async headObject(key: string): Promise<HeadResult | null> {
    const o = this.objects.get(key);
    return o ? { sizeBytes: o.body.byteLength, contentType: o.contentType, checksumSha256: Buffer.from(o.sha256, "hex").toString("base64") } : null;
  }

  async getRange(key: string, start: number, end: number) {
    const o = this.objects.get(key);
    return o ? o.body.slice(start, end + 1) : null;
  }

  async deleteObject(key: string) {
    this.objects.delete(key);
  }

  async presignPut(key: string, opts: { contentType: string; sizeBytes: number; sha256Hex: string; expiresInSeconds: number }): Promise<PresignedUpload> {
    this.presigned.set(key, opts);
    return {
      url: `memory://upload/${encodeURIComponent(key)}`,
      method: "PUT",
      headers: { "Content-Type": opts.contentType },
      expiresAt: new Date(Date.now() + opts.expiresInSeconds * 1000).toISOString(),
    };
  }

  async presignGet(key: string, opts: { expiresInSeconds: number; contentType: string; disposition: string }) {
    return `memory://download/${encodeURIComponent(key)}?ttl=${opts.expiresInSeconds}&disposition=${encodeURIComponent(opts.disposition)}`;
  }

  /** Test helper: uploads bytes as a client would (optionally bypassing the signed constraints). */
  async simulateUpload(key: string, body: Uint8Array, contentType?: string) {
    const signed = this.presigned.get(key);
    if (!signed) throw new Error("no presigned upload");
    this.objects.set(key, { body, contentType: contentType ?? signed.contentType, sha256: createHash("sha256").update(body).digest("hex") });
  }
}

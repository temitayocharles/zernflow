import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyEncryptionProvider, KekProviderId } from "./kek";

/** Stored shape of one encrypted secret version (columns of secret_versions). */
export interface SealedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDek: string;
  kekProvider: KekProviderId;
  kekKeyId: string;
  kekVersion: number | null;
}

export const MAX_SECRET_BYTES = 64 * 1024;

/** AAD binds ciphertext to tenant, secret and version: rows cannot be swapped. */
export function secretAad(workspaceId: string, secretId: string, version: number): string {
  return `zernflow:secret:v1|${workspaceId}|${secretId}|${version}`;
}

export class SecretIntegrityError extends Error {
  constructor() {
    super("secret ciphertext failed authentication");
    this.name = "SecretIntegrityError";
  }
}

export async function seal(plaintext: string, aad: string, kek: KeyEncryptionProvider): Promise<SealedValue> {
  const data = Buffer.from(plaintext, "utf8");
  if (data.length === 0) throw new RangeError("secret value is empty");
  if (data.length > MAX_SECRET_BYTES) throw new RangeError(`secret value exceeds ${MAX_SECRET_BYTES} bytes`);
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const wrapped = await kek.wrap(dek, aad);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      wrappedDek: wrapped.wrapped,
      kekProvider: kek.id,
      kekKeyId: wrapped.keyId,
      kekVersion: wrapped.version,
    };
  } finally {
    dek.fill(0);
    data.fill(0);
  }
}

export async function unseal(sealed: SealedValue, aad: string, kek: KeyEncryptionProvider): Promise<string> {
  if (sealed.kekProvider !== kek.id) {
    throw new SecretIntegrityError();
  }
  let dek: Buffer | undefined;
  try {
    dek = await kek.unwrap({ wrapped: sealed.wrappedDek, keyId: sealed.kekKeyId, version: sealed.kekVersion }, aad);
    const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch (err) {
    if (err instanceof Error && err.name === "SecretStoreConfigError") throw err;
    throw new SecretIntegrityError();
  } finally {
    dek?.fill(0);
  }
}

import "server-only";
import { StorageNotConfiguredError, type ObjectStore } from "./object-store";
import { readS3Config, S3ObjectStore } from "./s3";

let cached: { key: string; store: ObjectStore } | null = null;

/** Returns the configured object store or throws StorageNotConfiguredError. */
export function getObjectStore(env: Record<string, string | undefined> = process.env): ObjectStore {
  const cfg = readS3Config(env);
  if (!cfg) throw new StorageNotConfiguredError();
  const key = `${cfg.endpoint ?? ""}|${cfg.bucket}|${cfg.accessKeyId}`;
  if (!cached || cached.key !== key) cached = { key, store: new S3ObjectStore(cfg) };
  return cached.store;
}

export function objectStoreConfigured(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return readS3Config(env) !== null;
  } catch {
    return false;
  }
}

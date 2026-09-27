import "server-only";
import { ApiError, failure } from "@/lib/product/api";
import { InputError } from "@/lib/product/validation";
import { SecretError } from "./store";
import { SecretStoreConfigError } from "./kek";
import { MAX_SECRET_BYTES } from "./envelope";

/** Maps secret-store errors to HTTP without leaking internals. */
export function secretFailure(error: unknown) {
  if (error instanceof SecretError) {
    const status = { not_found: 404, conflict: 409, unavailable: 409, denied: 403, invalid: 400 }[error.code];
    return failure(new ApiError(status, error.message));
  }
  if (error instanceof SecretStoreConfigError) {
    return failure(new ApiError(503, "Secret store is not configured on this deployment (Vault Transit or local KEK)."));
  }
  if (error instanceof RangeError) return failure(new InputError(error.message));
  return failure(error);
}

/** Secret values are never trimmed or echoed; only length-checked. */
export function secretValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
    throw new InputError(`value must be a non-empty string up to ${MAX_SECRET_BYTES} bytes`);
  }
  return value;
}

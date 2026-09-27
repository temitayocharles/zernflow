import "server-only";
import { ApiError } from "@/lib/product/api";

/** Maps RPC errors from the scheduling functions to HTTP errors with their safe messages. */
export function rpcFailure(error: { code?: string; message?: string } | null): void {
  if (!error) return;
  const msg = (error.message ?? "").slice(0, 200) || "Request rejected";
  if (error.code === "42501") throw new ApiError(403, msg.includes("approval") ? msg : "Not permitted");
  if (error.code === "23514" || error.code === "22023") throw new ApiError(409, msg);
  throw new ApiError(503, "Scheduling is unavailable. Confirm migration 00033 is applied.");
}

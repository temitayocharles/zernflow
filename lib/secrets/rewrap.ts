import "server-only";
import type { ServiceClient, TaskHandler } from "@/lib/tasks/types";
import { TaskError } from "@/lib/tasks/errors";
import { InputError } from "@/lib/product/validation";
import { resolveKekProvider, SecretStoreConfigError, type KeyEncryptionProvider } from "./kek";
import { secretAad } from "./envelope";

/**
 * KEK rotation (R3 follow-up): re-wraps every active secret version's DEK under
 * the provider's current key. Ciphertext, IV, tag and DEK are unchanged, so
 * values stay readable throughout; each row is updated with compare-and-swap on
 * the old wrapped DEK so a concurrent rotate/rewrap never loses a write.
 *
 * Revoked versions are skipped (they are never decrypted again). Versions
 * wrapped by a different provider (e.g. local → Vault migration) are counted as
 * `foreignProvider` and left untouched — cross-provider migration is a separate,
 * explicit operation.
 */

export interface RewrapReport {
  scanned: number;
  rewrapped: number;
  current: number;
  foreignProvider: number;
  conflicts: number;
  failed: number;
  nextCursor: string | null;
}

export async function rewrapWorkspaceSecrets(
  service: ServiceClient,
  input: { workspaceId: string; cursor?: string | null; batchSize?: number; actorId: string },
  kek: KeyEncryptionProvider = resolveKekProvider(),
): Promise<RewrapReport> {
  if (!kek.rewrap) throw new SecretStoreConfigError(`KEK provider ${kek.id} does not support rewrap`);
  const batch = Math.min(Math.max(input.batchSize ?? 50, 1), 200);
  let q = service
    .from("secret_versions")
    .select("id, secret_id, version, wrapped_dek, kek_provider, kek_key_id, kek_version")
    .eq("workspace_id", input.workspaceId)
    .is("revoked_at", null)
    .order("id", { ascending: true })
    .limit(batch);
  if (input.cursor) q = q.gt("id", input.cursor);
  const { data: rows, error } = await q;
  if (error) throw new TaskError("transient", `secret version scan failed: ${error.code ?? "unknown"}`);

  const report: RewrapReport = { scanned: 0, rewrapped: 0, current: 0, foreignProvider: 0, conflicts: 0, failed: 0, nextCursor: null };
  for (const row of rows ?? []) {
    report.scanned++;
    if (row.kek_provider !== kek.id) {
      report.foreignProvider++;
      continue;
    }
    const wrapped = { wrapped: row.wrapped_dek, keyId: row.kek_key_id, version: row.kek_version };
    if (kek.needsRewrap && !kek.needsRewrap(wrapped)) {
      report.current++;
      continue;
    }
    let next;
    try {
      next = await kek.rewrap(wrapped, secretAad(input.workspaceId, row.secret_id, row.version));
    } catch {
      report.failed++;
      continue;
    }
    if (next.wrapped === row.wrapped_dek || (next.keyId === row.kek_key_id && next.version !== null && next.version === row.kek_version)) {
      report.current++;
      continue;
    }
    const { data: updated, error: upErr } = await service
      .from("secret_versions")
      .update({ wrapped_dek: next.wrapped, kek_key_id: next.keyId, kek_version: next.version })
      .eq("id", row.id)
      .eq("workspace_id", input.workspaceId)
      .eq("wrapped_dek", row.wrapped_dek)
      .select("id");
    if (upErr) {
      report.failed++;
      continue;
    }
    if (!updated?.length) {
      report.conflicts++;
      continue;
    }
    report.rewrapped++;
    await service.from("secret_access_events").insert({
      workspace_id: input.workspaceId,
      secret_id: row.secret_id,
      action: "rewrap",
      actor_type: "service",
      actor_id: input.actorId.slice(0, 200),
      purpose: "kek_rotation",
      outcome: "success",
      detail: { version: row.version, fromKeyId: row.kek_key_id, fromKekVersion: row.kek_version, toKeyId: next.keyId, toKekVersion: next.version },
    });
  }
  const list = rows ?? [];
  report.nextCursor = list.length === batch ? list[list.length - 1].id : null;
  return report;
}

interface RewrapInput extends Record<string, unknown> {
  batchSize: number;
}

/** `secrets.rewrap` — owner-started (or scheduled) KEK rotation for one workspace; resumable by cursor. */
export const secretsRewrapHandler: TaskHandler<RewrapInput> = {
  kind: "secrets.rewrap",
  title: "Re-wrap secrets under the current KEK",
  description:
    "After rotating the Vault Transit key (or setting ZERNFLOW_LOCAL_KEK_PREVIOUS), re-wraps every active secret's data key under the current key. Values stay readable throughout.",
  mode: "internal",
  schedulable: true,
  userRunnable: true,
  parseInput(input) {
    const v = (input ?? {}) as Record<string, unknown>;
    const size = v.batchSize === undefined ? 50 : v.batchSize;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 200) throw new InputError("batchSize must be an integer between 1 and 200");
    return { batchSize: size };
  },
  async run(ctx, input) {
    // Step format: "after:<last id>|failed:<n>" — carries the cursor and failures across batches.
    const m = /^after:([0-9a-f-]{36})\|failed:(\d+)$/.exec(ctx.task.current_step ?? "");
    const cursor = m?.[1] ?? null;
    const failedSoFar = m ? Number(m[2]) : 0;
    let kek: KeyEncryptionProvider;
    try {
      kek = resolveKekProvider();
    } catch (e) {
      throw new TaskError("policy_denied", e instanceof Error ? e.message : "Secret store is not configured");
    }
    const report = await rewrapWorkspaceSecrets(ctx.supabase, { workspaceId: ctx.task.workspace_id, cursor, batchSize: input.batchSize, actorId: `task:${ctx.task.id}` }, kek);
    await ctx.event("info", `Rewrap batch: ${report.rewrapped} rewrapped, ${report.current} current, ${report.failed} failed`, {
      scanned: report.scanned, rewrapped: report.rewrapped, current: report.current, foreignProvider: report.foreignProvider, conflicts: report.conflicts, failed: report.failed,
    });
    const failed = failedSoFar + report.failed;
    if (report.nextCursor) {
      return { status: "deferred", nextRunAt: new Date(Date.now() + 1_000), step: `after:${report.nextCursor}|failed:${failed}` };
    }
    if (failed > 0) {
      throw new TaskError("transient", `${failed} secret version(s) could not be re-wrapped; check the KEK provider and re-run`, { terminal: true });
    }
    return { status: "completed", result: { lastBatch: { ...report }, failed } };
  },
};

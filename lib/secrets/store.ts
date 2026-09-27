import "server-only";
import { randomUUID } from "node:crypto";
import type { Json } from "@/lib/types/database";
import type { SecretKind, SecretRow } from "@/lib/types/platform";
import type { ServiceClient } from "@/lib/tasks/types";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/observability/log";
import { resolveKekProvider, type KeyEncryptionProvider } from "./kek";
import { seal, secretAad, unseal } from "./envelope";

/**
 * Server-only secret store (see docs/architecture/SECRET_STORE_DESIGN.md).
 * Values enter once (create/rotate) and leave only through resolveSecret,
 * which requires a declared purpose and an identity, and is always audited.
 * No function here logs or returns plaintext except resolveSecret's result.
 */

export type SecretIdentity =
  | { type: "user"; id: string }
  | { type: "service"; id: string }
  /** Workers may only resolve the secrets the caller has verified are bound to their current lease. */
  | { type: "worker"; id: string; allowedSecretIds: readonly string[] };

export class SecretError extends Error {
  constructor(
    readonly code: "not_found" | "unavailable" | "conflict" | "denied" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "SecretError";
  }
}

export const SECRET_KINDS: readonly SecretKind[] = [
  "ai_provider_key",
  "webhook_signing",
  "browser_credential",
  "browser_session_state",
  "provider_app_credential",
  "api_token",
  "other",
];

/** Well-known bindings consumed by product code. */
export const SECRET_BINDINGS = {
  aiGatewayKey: "ai.gateway_key",
} as const;

export const SECRET_METADATA_COLUMNS =
  "id, workspace_id, name, kind, provider, description, binding, status, current_version, expires_at, last_used_at, last_used_by, rotated_at, created_by, created_at, updated_at, revoked_at, deleted_at";

interface Deps {
  kek?: KeyEncryptionProvider;
  now?: () => Date;
}

function actorLabel(identity: SecretIdentity) {
  return `${identity.type}:${identity.id}`.slice(0, 200);
}

async function accessEvent(
  service: ServiceClient,
  e: {
    workspaceId: string;
    secretId: string | null;
    action: "create" | "rotate" | "revoke" | "delete" | "resolve" | "resolve_denied" | "import";
    identity: SecretIdentity;
    purpose?: string;
    outcome?: "success" | "denied" | "error";
    detail?: Record<string, Json>;
  },
) {
  const { error } = await service.from("secret_access_events").insert({
    workspace_id: e.workspaceId,
    secret_id: e.secretId,
    action: e.action,
    actor_type: e.identity.type,
    actor_id: e.identity.id.slice(0, 200),
    purpose: e.purpose?.slice(0, 200) ?? null,
    outcome: e.outcome ?? "success",
    detail: e.detail ?? {},
  });
  if (error) throw new Error(`Secret audit write failed: ${error.code ?? "unknown"}`);
}

async function userAudit(service: ServiceClient, workspaceId: string, secretId: string, identity: SecretIdentity, action: string, changes: Record<string, unknown>) {
  await recordAudit(service, {
    workspaceId,
    entityType: "secret",
    entityId: secretId,
    actorId: identity.type === "user" ? identity.id : null,
    action,
    changes,
  });
}

function validateName(name: string) {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 200) throw new SecretError("invalid", "Name must be 1-200 characters");
  return trimmed;
}

async function loadSecret(service: ServiceClient, workspaceId: string, secretId: string): Promise<SecretRow> {
  const { data, error } = await service
    .from("secrets")
    .select(SECRET_METADATA_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", secretId)
    .maybeSingle();
  if (error) throw new Error(`Secret lookup failed: ${error.code ?? "unknown"}`);
  if (!data) throw new SecretError("not_found", "Secret not found");
  return data as SecretRow;
}

export async function createSecret(
  service: ServiceClient,
  input: {
    workspaceId: string;
    name: string;
    kind: SecretKind;
    value: string;
    provider?: string | null;
    description?: string;
    binding?: string | null;
    expiresAt?: string | null;
    identity: SecretIdentity;
    action?: "create" | "import";
  },
  deps: Deps = {},
): Promise<SecretRow> {
  if (!SECRET_KINDS.includes(input.kind)) throw new SecretError("invalid", "Unknown secret kind");
  const kek = deps.kek ?? resolveKekProvider();
  const secretId = randomUUID();
  const sealed = await seal(input.value, secretAad(input.workspaceId, secretId, 1), kek);

  const { data, error } = await service
    .from("secrets")
    .insert({
      id: secretId,
      workspace_id: input.workspaceId,
      name: validateName(input.name),
      kind: input.kind,
      provider: input.provider ?? null,
      description: input.description ?? "",
      binding: input.binding ?? null,
      expires_at: input.expiresAt ?? null,
      created_by: input.identity.type === "user" ? input.identity.id : null,
    })
    .select(SECRET_METADATA_COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") throw new SecretError("conflict", "A live secret with that name or binding already exists");
    if (error.code === "23514") throw new SecretError("invalid", "Secret metadata is invalid");
    throw new Error(`Secret create failed: ${error.code ?? "unknown"}`);
  }

  const { error: versionError } = await service.from("secret_versions").insert({
    workspace_id: input.workspaceId,
    secret_id: secretId,
    version: 1,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    auth_tag: sealed.authTag,
    wrapped_dek: sealed.wrappedDek,
    kek_provider: sealed.kekProvider,
    kek_key_id: sealed.kekKeyId,
    kek_version: sealed.kekVersion,
    created_by: actorLabel(input.identity),
  });
  if (versionError) {
    await service.from("secrets").delete().eq("id", secretId).eq("workspace_id", input.workspaceId);
    throw new Error(`Secret version write failed: ${versionError.code ?? "unknown"}`);
  }

  const action = input.action ?? "create";
  await accessEvent(service, { workspaceId: input.workspaceId, secretId, action, identity: input.identity, detail: { kind: input.kind, kek: sealed.kekProvider } });
  await userAudit(service, input.workspaceId, secretId, input.identity, `secret.${action}`, { name: input.name, kind: input.kind, binding: input.binding ?? null });
  return data as SecretRow;
}

export async function rotateSecret(
  service: ServiceClient,
  input: { workspaceId: string; secretId: string; value: string; identity: SecretIdentity },
  deps: Deps = {},
): Promise<SecretRow> {
  const kek = deps.kek ?? resolveKekProvider();
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const secret = await loadSecret(service, input.workspaceId, input.secretId);
  if (secret.status !== "active") throw new SecretError("unavailable", "Only active secrets can be rotated");
  const version = secret.current_version + 1;
  const sealed = await seal(input.value, secretAad(input.workspaceId, secret.id, version), kek);

  const { error: versionError } = await service.from("secret_versions").insert({
    workspace_id: input.workspaceId,
    secret_id: secret.id,
    version,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    auth_tag: sealed.authTag,
    wrapped_dek: sealed.wrappedDek,
    kek_provider: sealed.kekProvider,
    kek_key_id: sealed.kekKeyId,
    kek_version: sealed.kekVersion,
    created_by: actorLabel(input.identity),
  });
  if (versionError) {
    if (versionError.code === "23505") throw new SecretError("conflict", "Secret was rotated concurrently; retry");
    throw new Error(`Secret version write failed: ${versionError.code ?? "unknown"}`);
  }

  // Compare-and-swap on current_version so concurrent rotations cannot interleave.
  const { data, error } = await service
    .from("secrets")
    .update({ current_version: version, rotated_at: now })
    .eq("id", secret.id)
    .eq("workspace_id", input.workspaceId)
    .eq("current_version", secret.current_version)
    .eq("status", "active")
    .select(SECRET_METADATA_COLUMNS);
  if (error || !data || data.length !== 1) {
    await service.from("secret_versions").delete().eq("secret_id", secret.id).eq("version", version);
    throw new SecretError("conflict", "Secret changed during rotation; retry");
  }
  await service
    .from("secret_versions")
    .update({ revoked_at: now })
    .eq("secret_id", secret.id)
    .lt("version", version)
    .is("revoked_at", null);

  await accessEvent(service, { workspaceId: input.workspaceId, secretId: secret.id, action: "rotate", identity: input.identity, detail: { version } });
  await userAudit(service, input.workspaceId, secret.id, input.identity, "secret.rotate", { version });
  return data[0] as SecretRow;
}

export async function revokeSecret(
  service: ServiceClient,
  input: { workspaceId: string; secretId: string; identity: SecretIdentity; reason?: string },
  deps: Deps = {},
): Promise<SecretRow> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const secret = await loadSecret(service, input.workspaceId, input.secretId);
  if (secret.status === "deleted") throw new SecretError("unavailable", "Secret is deleted");
  if (secret.status === "revoked") return secret;
  const { data, error } = await service
    .from("secrets")
    .update({ status: "revoked", revoked_at: now })
    .eq("id", secret.id)
    .eq("workspace_id", input.workspaceId)
    .select(SECRET_METADATA_COLUMNS)
    .single();
  if (error || !data) throw new Error(`Secret revoke failed: ${error?.code ?? "unknown"}`);
  await service.from("secret_versions").update({ revoked_at: now }).eq("secret_id", secret.id).is("revoked_at", null);
  await accessEvent(service, { workspaceId: input.workspaceId, secretId: secret.id, action: "revoke", identity: input.identity, detail: { reason: (input.reason ?? "").slice(0, 200) } });
  await userAudit(service, input.workspaceId, secret.id, input.identity, "secret.revoke", { reason: input.reason ?? null });
  return data as SecretRow;
}

/** Crypto-shred: ciphertext rows are deleted; metadata is tombstoned for audit. */
export async function deleteSecret(
  service: ServiceClient,
  input: { workspaceId: string; secretId: string; identity: SecretIdentity },
  deps: Deps = {},
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const secret = await loadSecret(service, input.workspaceId, input.secretId);
  if (secret.status === "deleted") return;
  const { error: shredError } = await service
    .from("secret_versions")
    .delete()
    .eq("secret_id", secret.id)
    .eq("workspace_id", input.workspaceId);
  if (shredError) throw new Error(`Secret shred failed: ${shredError.code ?? "unknown"}`);
  const { error } = await service
    .from("secrets")
    .update({ status: "deleted", deleted_at: now, binding: null, revoked_at: secret.revoked_at ?? now })
    .eq("id", secret.id)
    .eq("workspace_id", input.workspaceId);
  if (error) throw new Error(`Secret delete failed: ${error.code ?? "unknown"}`);
  await accessEvent(service, { workspaceId: input.workspaceId, secretId: secret.id, action: "delete", identity: input.identity });
  await userAudit(service, input.workspaceId, secret.id, input.identity, "secret.delete", { name: secret.name });
}

export interface ResolvedSecret {
  secretId: string;
  version: number;
  value: string;
}

/**
 * Decrypt the current version. Fails closed (typed SecretError) for missing,
 * revoked, deleted, expired or out-of-scope secrets; every attempt is audited.
 */
export async function resolveSecret(
  service: ServiceClient,
  input: { workspaceId: string; purpose: string; identity: SecretIdentity } & ({ secretId: string } | { binding: string }),
  deps: Deps = {},
): Promise<ResolvedSecret> {
  const now = (deps.now ?? (() => new Date()))();
  if (!input.purpose.trim()) throw new SecretError("invalid", "A purpose is required to resolve a secret");

  let secret: SecretRow;
  if ("secretId" in input) {
    secret = await loadSecret(service, input.workspaceId, input.secretId);
  } else {
    const { data, error } = await service
      .from("secrets")
      .select(SECRET_METADATA_COLUMNS)
      .eq("workspace_id", input.workspaceId)
      .eq("binding", input.binding)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw new Error(`Secret lookup failed: ${error.code ?? "unknown"}`);
    if (!data) throw new SecretError("not_found", `No active secret bound to ${input.binding}`);
    secret = data as SecretRow;
  }

  const deny = async (reason: string, code: SecretError["code"]) => {
    await accessEvent(service, {
      workspaceId: input.workspaceId,
      secretId: secret.id,
      action: "resolve_denied",
      identity: input.identity,
      purpose: input.purpose,
      outcome: "denied",
      detail: { reason },
    });
    logger.warn("secret.resolve_denied", { workspaceId: input.workspaceId, secretId: secret.id, reason, actor: input.identity.type });
    return new SecretError(code, `Secret unavailable: ${reason}`);
  };

  if (input.identity.type === "worker" && !input.identity.allowedSecretIds.includes(secret.id)) {
    throw await deny("not bound to the worker's current lease", "denied");
  }
  if (secret.status !== "active") throw await deny(secret.status, "unavailable");
  if (secret.expires_at && new Date(secret.expires_at).getTime() <= now.getTime()) throw await deny("expired", "unavailable");

  const { data: version, error } = await service
    .from("secret_versions")
    .select("ciphertext, iv, auth_tag, wrapped_dek, kek_provider, kek_key_id, kek_version, version")
    .eq("workspace_id", input.workspaceId)
    .eq("secret_id", secret.id)
    .eq("version", secret.current_version)
    .maybeSingle();
  if (error) throw new Error(`Secret version lookup failed: ${error.code ?? "unknown"}`);
  if (!version) throw await deny("ciphertext missing", "unavailable");

  const kek = deps.kek ?? resolveKekProvider();
  let value: string;
  try {
    value = await unseal(
      {
        ciphertext: version.ciphertext,
        iv: version.iv,
        authTag: version.auth_tag,
        wrappedDek: version.wrapped_dek,
        kekProvider: version.kek_provider,
        kekKeyId: version.kek_key_id,
        kekVersion: version.kek_version,
      },
      secretAad(input.workspaceId, secret.id, version.version),
      kek,
    );
  } catch (err) {
    await accessEvent(service, {
      workspaceId: input.workspaceId,
      secretId: secret.id,
      action: "resolve",
      identity: input.identity,
      purpose: input.purpose,
      outcome: "error",
      detail: { error: err instanceof Error ? err.name : "unknown" },
    });
    throw err;
  }

  await service
    .from("secrets")
    .update({ last_used_at: now.toISOString(), last_used_by: actorLabel(input.identity) })
    .eq("id", secret.id)
    .eq("workspace_id", input.workspaceId);
  await accessEvent(service, {
    workspaceId: input.workspaceId,
    secretId: secret.id,
    action: "resolve",
    identity: input.identity,
    purpose: input.purpose,
    detail: { version: version.version },
  });
  return { secretId: secret.id, version: version.version, value };
}

/**
 * Moves the legacy plaintext `workspaces.ai_api_key` into the store under the
 * `ai.gateway_key` binding and clears the column (compare-and-swap on value).
 * Zernio-era columns stay until the Zernio stage-2 removal (manifest §3).
 */
export async function importLegacyAiKey(
  service: ServiceClient,
  input: { workspaceId: string; identity: SecretIdentity },
  deps: Deps = {},
): Promise<{ status: "imported"; secretId: string } | { status: "nothing_to_import" } | { status: "binding_exists"; secretId: string }> {
  const { data: ws, error } = await service.from("workspaces").select("ai_api_key").eq("id", input.workspaceId).single();
  if (error) throw new Error(`Workspace lookup failed: ${error.code ?? "unknown"}`);
  const legacy = ws?.ai_api_key;
  if (!legacy) return { status: "nothing_to_import" };

  const { data: existing } = await service
    .from("secrets")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("binding", SECRET_BINDINGS.aiGatewayKey)
    .eq("status", "active")
    .maybeSingle();
  if (existing) return { status: "binding_exists", secretId: existing.id };

  const secret = await createSecret(
    service,
    {
      workspaceId: input.workspaceId,
      name: "AI Gateway key (imported)",
      kind: "ai_provider_key",
      provider: "vercel-ai-gateway",
      description: "Imported from the legacy workspace column.",
      binding: SECRET_BINDINGS.aiGatewayKey,
      value: legacy,
      identity: input.identity,
      action: "import",
    },
    deps,
  );
  await service.from("workspaces").update({ ai_api_key: null }).eq("id", input.workspaceId).eq("ai_api_key", legacy);
  return { status: "imported", secretId: secret.id };
}

/** Resolves a bound secret if configured; returns null when absent (callers fall back). */
export async function resolveBindingOrNull(
  service: ServiceClient,
  input: { workspaceId: string; binding: string; purpose: string; identity: SecretIdentity },
  deps: Deps = {},
): Promise<string | null> {
  try {
    return (await resolveSecret(service, input, deps)).value;
  } catch (err) {
    if (err instanceof SecretError && err.code === "not_found") return null;
    throw err;
  }
}

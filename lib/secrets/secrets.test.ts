import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LocalKeyProvider, VaultTransitKeyProvider, resolveKekProvider, SecretStoreConfigError } from "./kek";
import { seal, secretAad, unseal, SecretIntegrityError } from "./envelope";
import {
  createSecret,
  deleteSecret,
  importLegacyAiKey,
  resolveSecret,
  revokeSecret,
  rotateSecret,
  SecretError,
  SECRET_BINDINGS,
} from "./store";
import { createMemorySupabase } from "@/lib/test/memory-supabase";

const kek = new LocalKeyProvider(randomBytes(32));
const WS = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const user = { type: "user" as const, id: "33333333-3333-4333-8333-333333333333" };

function memory(seed: Record<string, Record<string, unknown>[]> = {}) {
  return createMemorySupabase(
    { workspaces: [{ id: WS, ai_api_key: null }], ...seed },
    {
      constraints: {
        secrets: (row, rows) =>
          rows.some(
            (r) =>
              r.id !== row.id &&
              r.workspace_id === row.workspace_id &&
              ((r.status !== "deleted" && row.status !== "deleted" && String(r.name).toLowerCase() === String(row.name).toLowerCase()) ||
                (row.binding && r.binding === row.binding && r.status === "active" && row.status !== "deleted")),
          )
            ? "23505"
            : null,
        secret_versions: (row, rows) => (rows.some((r) => r.secret_id === row.secret_id && r.version === row.version) ? "23505" : null),
      },
      defaults: {
        secrets: () => ({ status: "active", current_version: 1, revoked_at: null, expires_at: null, binding: null, deleted_at: null }),
        secret_versions: () => ({ revoked_at: null, kek_version: null }),
      },
    },
  );
}

describe("envelope encryption", () => {
  it("round-trips and binds ciphertext to workspace, secret and version via AAD", async () => {
    const aad = secretAad(WS, "s1", 1);
    const sealed = await seal("sk-live-value", aad, kek);
    expect(sealed.ciphertext).not.toContain("sk-live");
    expect(await unseal(sealed, aad, kek)).toBe("sk-live-value");
    await expect(unseal(sealed, secretAad(OTHER, "s1", 1), kek)).rejects.toBeInstanceOf(SecretIntegrityError);
    await expect(unseal(sealed, secretAad(WS, "s1", 2), kek)).rejects.toBeInstanceOf(SecretIntegrityError);
    const tampered = { ...sealed, ciphertext: Buffer.from("x" + sealed.ciphertext).toString("base64") };
    await expect(unseal(tampered, aad, kek)).rejects.toBeInstanceOf(SecretIntegrityError);
    // A different KEK cannot unwrap.
    await expect(unseal(sealed, aad, new LocalKeyProvider(randomBytes(32)))).rejects.toBeInstanceOf(SecretIntegrityError);
  });

  it("uses a fresh DEK and IV per seal", async () => {
    const a = await seal("same", "aad", kek);
    const b = await seal("same", "aad", kek);
    expect(a.iv).not.toBe(b.iv);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects empty and oversize values", async () => {
    await expect(seal("", "aad", kek)).rejects.toThrow(/empty/);
    await expect(seal("x".repeat(70_000), "aad", kek)).rejects.toThrow(/exceeds/);
  });
});

describe("KEK providers", () => {
  it("refuses the local KEK in production unless explicitly allowed", () => {
    const key = randomBytes(32).toString("base64");
    expect(() => resolveKekProvider({ ZERNFLOW_LOCAL_KEK: key, NODE_ENV: "production" })).toThrow(SecretStoreConfigError);
    expect(resolveKekProvider({ ZERNFLOW_LOCAL_KEK: key, NODE_ENV: "production", ZERNFLOW_ALLOW_LOCAL_KEK: "true" }).id).toBe("local");
    expect(resolveKekProvider({ ZERNFLOW_LOCAL_KEK: key, NODE_ENV: "development" }).id).toBe("local");
    expect(() => resolveKekProvider({ ZERNFLOW_LOCAL_KEK: "c2hvcnQ=" })).toThrow(/32 bytes/);
    expect(() => resolveKekProvider({})).toThrow(/not configured/);
  });

  it("wraps through Vault transit without sending the DEK anywhere else", async () => {
    const calls: Array<{ url: string; body: Record<string, string>; headers: Record<string, string> }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body, headers: init.headers as Record<string, string> });
      if (url.endsWith("/encrypt/zernflow")) {
        return new Response(JSON.stringify({ data: { ciphertext: `vault:v3:${Buffer.from(body.plaintext).toString("hex")}` } }));
      }
      const hex = String(body.ciphertext).replace(/^vault:v\d+:/, "");
      return new Response(JSON.stringify({ data: { plaintext: Buffer.from(hex, "hex").toString() } }));
    });
    const vault = new VaultTransitKeyProvider({ addr: "https://vault.example.com", token: "t", key: "zernflow", fetch: fakeFetch });
    const sealed = await seal("secret", "aad", vault);
    expect(sealed).toMatchObject({ kekProvider: "vault-transit", kekKeyId: "vault:zernflow", kekVersion: 3 });
    expect(await unseal(sealed, "aad", vault)).toBe("secret");
    expect(calls[0].headers["X-Vault-Token"]).toBe("t");
    expect(calls.map((c) => c.url)).toEqual([
      "https://vault.example.com/v1/transit/encrypt/zernflow",
      "https://vault.example.com/v1/transit/decrypt/zernflow",
    ]);
    expect(() => new VaultTransitKeyProvider({ addr: "http://vault.example.com", token: "t", key: "k" })).toThrow(/https/);
    expect(() => new VaultTransitKeyProvider({ addr: "https://v", token: "t", key: "../x" })).toThrow(/invalid/);
  });

  it("fails closed when Vault errors", async () => {
    const vault = new VaultTransitKeyProvider({
      addr: "https://vault.example.com",
      token: "t",
      key: "k",
      fetch: async () => new Response("denied", { status: 403 }),
    });
    await expect(seal("secret", "aad", vault)).rejects.toThrow(/HTTP 403/);
  });
});

describe("secret store lifecycle", () => {
  it("creates, resolves (audited, last-used), rotates, revokes and crypto-shreds", async () => {
    const db = memory();
    const client = db.client as never;
    const created = await createSecret(client, { workspaceId: WS, name: "OpenAI", kind: "ai_provider_key", value: "sk-one-1234567890", identity: user }, { kek });
    expect(JSON.stringify(created)).not.toContain("sk-one");
    expect(JSON.stringify(db.tables.product_activity)).not.toContain("sk-one");
    expect(JSON.stringify(db.tables.secret_versions)).not.toContain("sk-one");

    const first = await resolveSecret(client, { workspaceId: WS, secretId: created.id, purpose: "test", identity: user }, { kek });
    expect(first).toMatchObject({ value: "sk-one-1234567890", version: 1 });
    expect(db.tables.secrets[0].last_used_by).toBe(`user:${user.id}`);

    await rotateSecret(client, { workspaceId: WS, secretId: created.id, value: "sk-two-1234567890", identity: user }, { kek });
    const second = await resolveSecret(client, { workspaceId: WS, secretId: created.id, purpose: "test", identity: user }, { kek });
    expect(second).toMatchObject({ value: "sk-two-1234567890", version: 2 });
    expect(db.tables.secret_versions.find((v) => v.version === 1)?.revoked_at).toBeTruthy();

    await revokeSecret(client, { workspaceId: WS, secretId: created.id, identity: user }, { kek });
    await expect(resolveSecret(client, { workspaceId: WS, secretId: created.id, purpose: "test", identity: user }, { kek })).rejects.toMatchObject({ code: "unavailable" });

    await deleteSecret(client, { workspaceId: WS, secretId: created.id, identity: user }, { kek });
    expect(db.tables.secret_versions).toHaveLength(0);
    expect(db.tables.secrets[0].status).toBe("deleted");
    const actions = db.tables.secret_access_events.map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toEqual(["create:success", "resolve:success", "rotate:success", "resolve:success", "revoke:success", "resolve_denied:denied", "delete:success"]);
  });

  it("isolates tenants: a secret cannot be resolved through another workspace", async () => {
    const db = memory();
    const client = db.client as never;
    const s = await createSecret(client, { workspaceId: WS, name: "Hook", kind: "webhook_signing", value: "whsec", identity: user }, { kek });
    await expect(resolveSecret(client, { workspaceId: OTHER, secretId: s.id, purpose: "x", identity: user }, { kek })).rejects.toMatchObject({ code: "not_found" });
  });

  it("limits workers to secrets bound to their lease and denies expired secrets", async () => {
    const db = memory();
    const client = db.client as never;
    const s = await createSecret(client, { workspaceId: WS, name: "Cookies", kind: "browser_session_state", value: "{}", identity: user, expiresAt: "2030-01-01T00:00:00Z" }, { kek });
    const worker = { type: "worker" as const, id: "w1", allowedSecretIds: [] };
    await expect(resolveSecret(client, { workspaceId: WS, secretId: s.id, purpose: "browser", identity: worker }, { kek })).rejects.toMatchObject({ code: "denied" });
    const ok = await resolveSecret(client, { workspaceId: WS, secretId: s.id, purpose: "browser", identity: { ...worker, allowedSecretIds: [s.id] } }, { kek });
    expect(ok.value).toBe("{}");
    await expect(
      resolveSecret(client, { workspaceId: WS, secretId: s.id, purpose: "x", identity: user }, { kek, now: () => new Date("2031-01-01") }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("rejects duplicate live names and requires a purpose", async () => {
    const db = memory();
    const client = db.client as never;
    const s = await createSecret(client, { workspaceId: WS, name: "Dup", kind: "other", value: "v", identity: user }, { kek });
    await expect(createSecret(client, { workspaceId: WS, name: "dup", kind: "other", value: "v", identity: user }, { kek })).rejects.toMatchObject({ code: "conflict" });
    await expect(resolveSecret(client, { workspaceId: WS, secretId: s.id, purpose: " ", identity: user }, { kek })).rejects.toBeInstanceOf(SecretError);
  });

  it("rolls back metadata when the ciphertext write fails", async () => {
    const db = memory();
    db.failNext("secret_versions", "insert");
    await expect(createSecret(db.client as never, { workspaceId: WS, name: "X", kind: "other", value: "v", identity: user }, { kek })).rejects.toThrow(/version write failed/);
    expect(db.tables.secrets).toHaveLength(0);
  });

  it("imports the legacy AI key once and clears the plaintext column", async () => {
    const db = memory({ workspaces: [{ id: WS, ai_api_key: "legacy-ai-key-000000" }] });
    const client = db.client as never;
    const res = await importLegacyAiKey(client, { workspaceId: WS, identity: user }, { kek });
    expect(res.status).toBe("imported");
    expect(db.tables.workspaces[0].ai_api_key).toBeNull();
    const resolved = await resolveSecret(client, { workspaceId: WS, binding: SECRET_BINDINGS.aiGatewayKey, purpose: "ai", identity: user }, { kek });
    expect(resolved.value).toBe("legacy-ai-key-000000");
    expect(await importLegacyAiKey(client, { workspaceId: WS, identity: user }, { kek })).toEqual({ status: "nothing_to_import" });
    expect(db.tables.secret_access_events[0].action).toBe("import");
  });
});

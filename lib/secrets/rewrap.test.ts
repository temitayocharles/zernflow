import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemorySupabase } from "@/lib/test/memory-supabase";
import { readBudget } from "@/lib/runtime/budget";
import { LocalKeyProvider, VaultTransitKeyProvider, resolveKekProvider } from "./kek";
import { seal, secretAad, unseal } from "./envelope";
import { rewrapWorkspaceSecrets, secretsRewrapHandler } from "./rewrap";

const WS = "11111111-1111-4111-8111-111111111111";
const oldKey = randomBytes(32);
const newKey = randomBytes(32);

async function versionRow(id: string, secretId: string, kek: LocalKeyProvider, value = "s3cret") {
  const sealed = await seal(value, secretAad(WS, secretId, 1), kek);
  return {
    id, workspace_id: WS, secret_id: secretId, version: 1, revoked_at: null,
    ciphertext: sealed.ciphertext, iv: sealed.iv, auth_tag: sealed.authTag, wrapped_dek: sealed.wrappedDek,
    kek_provider: sealed.kekProvider, kek_key_id: sealed.kekKeyId, kek_version: sealed.kekVersion,
  };
}

const read = (row: Record<string, unknown>, kek: LocalKeyProvider) =>
  unseal({ ciphertext: row.ciphertext as string, iv: row.iv as string, authTag: row.auth_tag as string, wrappedDek: row.wrapped_dek as string, kekProvider: "local", kekKeyId: row.kek_key_id as string, kekVersion: row.kek_version as number }, secretAad(WS, row.secret_id as string, 1), kek);

describe("local KEK rotation", () => {
  it("reads with previous keys and rewraps to the current key without touching ciphertext", async () => {
    const before = new LocalKeyProvider(oldKey, "local:2025");
    const rotated = new LocalKeyProvider(newKey, "local:2026", [{ key: oldKey, keyId: "local:2025" }]);
    const rows = [
      await versionRow("a0000000-0000-4000-8000-000000000001", "s1", before),
      await versionRow("a0000000-0000-4000-8000-000000000002", "s2", before, "other"),
      { ...(await versionRow("a0000000-0000-4000-8000-000000000003", "s3", before)), revoked_at: "2026-01-01" },
    ];
    const cipherBefore = rows[0].ciphertext;
    const db = createMemorySupabase({ secret_versions: rows, secret_access_events: [] });

    expect(await read(rows[0], rotated)).toBe("s3cret"); // readable during rotation
    const report = await rewrapWorkspaceSecrets(db.client as never, { workspaceId: WS, actorId: "test" }, rotated);
    expect(report).toMatchObject({ scanned: 2, rewrapped: 2, current: 0, failed: 0, nextCursor: null });
    const [r1, r2, r3] = db.tables.secret_versions;
    expect(r1).toMatchObject({ kek_key_id: "local:2026", ciphertext: cipherBefore });
    expect(r3.kek_key_id).toBe("local:2025"); // revoked versions are left alone
    // After rotation, the new key alone decrypts.
    const newOnly = new LocalKeyProvider(newKey, "local:2026");
    expect(await read(r1, newOnly)).toBe("s3cret");
    expect(await read(r2, newOnly)).toBe("other");
    expect(db.tables.secret_access_events).toHaveLength(2);
    expect(db.tables.secret_access_events[0]).toMatchObject({ action: "rewrap", actor_type: "service", purpose: "kek_rotation", detail: { fromKeyId: "local:2025", toKeyId: "local:2026" } });

    // Second run is a no-op.
    expect(await rewrapWorkspaceSecrets(db.client as never, { workspaceId: WS, actorId: "test" }, rotated)).toMatchObject({ rewrapped: 0, current: 2 });
  });

  it("pages by cursor, counts foreign providers and unreadable rows, and never loses a concurrent write", async () => {
    const before = new LocalKeyProvider(oldKey, "local:2025");
    const rotated = new LocalKeyProvider(newKey, "local:2026", [{ key: oldKey, keyId: "local:2025" }]);
    const rows = [
      await versionRow("b0000000-0000-4000-8000-000000000001", "s1", before),
      { ...(await versionRow("b0000000-0000-4000-8000-000000000002", "s2", before)), kek_provider: "vault-transit" },
      { ...(await versionRow("b0000000-0000-4000-8000-000000000003", "s3", before)), kek_key_id: "local:lost" },
    ];
    const db = createMemorySupabase({ secret_versions: rows, secret_access_events: [] });
    const page1 = await rewrapWorkspaceSecrets(db.client as never, { workspaceId: WS, actorId: "t", batchSize: 2 }, rotated);
    expect(page1).toMatchObject({ scanned: 2, rewrapped: 1, foreignProvider: 1, nextCursor: "b0000000-0000-4000-8000-000000000002" });
    const page2 = await rewrapWorkspaceSecrets(db.client as never, { workspaceId: WS, actorId: "t", batchSize: 2, cursor: page1.nextCursor }, rotated);
    expect(page2).toMatchObject({ scanned: 1, failed: 1, nextCursor: null });

    // CAS: a row rotated between read and write is reported as a conflict, not overwritten.
    const racing = await versionRow("c0000000-0000-4000-8000-000000000001", "s9", before);
    const db2 = createMemorySupabase({ secret_versions: [racing], secret_access_events: [] });
    const sneaky = new LocalKeyProvider(newKey, "local:2026", [{ key: oldKey, keyId: "local:2025" }]);
    const original = sneaky.rewrap.bind(sneaky);
    sneaky.rewrap = async (w, c) => {
      db2.tables.secret_versions[0].wrapped_dek = "rotated-concurrently";
      return original(w, c);
    };
    expect(await rewrapWorkspaceSecrets(db2.client as never, { workspaceId: WS, actorId: "t" }, sneaky)).toMatchObject({ conflicts: 1, rewrapped: 0 });
    expect(db2.tables.secret_versions[0].wrapped_dek).toBe("rotated-concurrently");
  });

  it("rejects ambiguous previous-key configuration", () => {
    expect(() => new LocalKeyProvider(newKey, "same", [{ key: oldKey, keyId: "same" }])).toThrow(/must differ/);
    expect(() => resolveKekProvider({ ZERNFLOW_LOCAL_KEK: newKey.toString("base64"), ZERNFLOW_LOCAL_KEK_PREVIOUS: oldKey.toString("base64") })).toThrow(/PREVIOUS_ID is required/);
    const p = resolveKekProvider({ ZERNFLOW_LOCAL_KEK: newKey.toString("base64"), ZERNFLOW_LOCAL_KEK_ID: "k2", ZERNFLOW_LOCAL_KEK_PREVIOUS: oldKey.toString("base64"), ZERNFLOW_LOCAL_KEK_PREVIOUS_ID: "k1" });
    expect(p.needsRewrap!({ wrapped: "x", keyId: "k1", version: 1 })).toBe(true);
    expect(p.needsRewrap!({ wrapped: "x", keyId: "k2", version: 1 })).toBe(false);
  });
});

describe("Vault transit rewrap", () => {
  it("calls POST /v1/transit/rewrap/:key and reports the new key version", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const vault = new VaultTransitKeyProvider({
      addr: "https://vault.example", token: "t", key: "zernflow",
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ data: { ciphertext: "vault:v3:abc", key_version: 3 } }), { status: 200 });
      },
    });
    const out = await vault.rewrap({ wrapped: "vault:v1:old", keyId: "vault:zernflow", version: 1 }, "ctx");
    expect(out).toEqual({ wrapped: "vault:v3:abc", keyId: "vault:zernflow", version: 3 });
    expect(calls).toEqual([{ url: "https://vault.example/v1/transit/rewrap/zernflow", body: { ciphertext: "vault:v1:old" } }]);
    await expect(vault.rewrap({ wrapped: "vault:v1:x", keyId: "vault:other", version: 1 }, "c")).rejects.toThrow(/different Vault key/);
  });

  it("skips rows already at the latest version (no write, no audit event)", async () => {
    const vault = new VaultTransitKeyProvider({
      addr: "https://vault.example", token: "t", key: "zernflow",
      fetch: async () => new Response(JSON.stringify({ data: { ciphertext: "vault:v2:same-version", key_version: 2 } }), { status: 200 }),
    });
    const db = createMemorySupabase({
      secret_versions: [{ id: "d0000000-0000-4000-8000-000000000001", workspace_id: WS, secret_id: "s", version: 1, revoked_at: null, wrapped_dek: "vault:v2:current", kek_provider: "vault-transit", kek_key_id: "vault:zernflow", kek_version: 2 }],
      secret_access_events: [],
    });
    expect(await rewrapWorkspaceSecrets(db.client as never, { workspaceId: WS, actorId: "t" }, vault)).toMatchObject({ current: 1, rewrapped: 0 });
    expect(db.tables.secret_access_events).toHaveLength(0);
  });
});

describe("secrets.rewrap task", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("resumes by cursor across batches and fails terminally if any row could not be rewrapped", async () => {
    const before = new LocalKeyProvider(oldKey, "local:2025");
    vi.stubEnv("SECRET_STORE_KEK_PROVIDER", "local");
    vi.stubEnv("ZERNFLOW_LOCAL_KEK", newKey.toString("base64"));
    vi.stubEnv("ZERNFLOW_LOCAL_KEK_ID", "local:2026");
    vi.stubEnv("ZERNFLOW_LOCAL_KEK_PREVIOUS", oldKey.toString("base64"));
    vi.stubEnv("ZERNFLOW_LOCAL_KEK_PREVIOUS_ID", "local:2025");
    const db = createMemorySupabase({
      secret_versions: [
        await versionRow("e0000000-0000-4000-8000-000000000001", "s1", before),
        { ...(await versionRow("e0000000-0000-4000-8000-000000000002", "s2", before)), kek_key_id: "local:lost" },
      ],
      secret_access_events: [],
      task_events: [],
    });
    const ctx = (step: string | null) => ({
      task: { id: "t1", workspace_id: WS, current_step: step, attempts: 1 },
      supabase: db.client, budget: readBudget({}), deadline: Date.now() + 20_000,
      event: async () => undefined, execute: async <T,>(_: unknown, fn: () => Promise<T>) => fn(),
    }) as never;
    const input = secretsRewrapHandler.parseInput({ batchSize: 1 });
    expect(() => secretsRewrapHandler.parseInput({ batchSize: 0 })).toThrow(/between 1 and 200/);
    const first = await secretsRewrapHandler.run!(ctx(null), input);
    expect(first).toMatchObject({ status: "deferred", step: "after:e0000000-0000-4000-8000-000000000001|failed:0" });
    const second = await secretsRewrapHandler.run!(ctx((first as { step: string }).step), input);
    expect(second).toMatchObject({ status: "deferred", step: "after:e0000000-0000-4000-8000-000000000002|failed:1" });
    await expect(secretsRewrapHandler.run!(ctx((second as { step: string }).step), input)).rejects.toMatchObject({ errorClass: "transient", options: { terminal: true } });
  });

  it("refuses to run without a configured secret store", async () => {
    vi.stubEnv("SECRET_STORE_KEK_PROVIDER", "");
    vi.stubEnv("ZERNFLOW_LOCAL_KEK", "");
    vi.stubEnv("VAULT_ADDR", "");
    const ctx = { task: { id: "t", workspace_id: WS, current_step: null }, supabase: createMemorySupabase({}).client, event: async () => undefined } as never;
    await expect(secretsRewrapHandler.run!(ctx, { batchSize: 10 })).rejects.toMatchObject({ errorClass: "policy_denied" });
  });
});

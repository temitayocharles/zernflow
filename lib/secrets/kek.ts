import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Key-encryption providers. The root KEK never lives in the database:
 *  - `vault-transit` (production): DEKs are wrapped by HashiCorp Vault Transit.
 *  - `local` (development / single-node self-hosted): AES-256-GCM key wrap with
 *    a 32-byte KEK from ZERNFLOW_LOCAL_KEK. Refused in production unless
 *    ZERNFLOW_ALLOW_LOCAL_KEK=true is set explicitly.
 * No custom primitives: Node's AES-256-GCM and Vault's transit engine only.
 */
export type KekProviderId = "local" | "vault-transit";

export interface WrappedKey {
  wrapped: string;
  keyId: string;
  version: number | null;
}

export interface KeyEncryptionProvider {
  readonly id: KekProviderId;
  wrap(dek: Buffer, context: string): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey, context: string): Promise<Buffer>;
  /**
   * KEK rotation: re-wrap an existing DEK under the provider's *current* key
   * without changing the DEK or the ciphertext. Vault does this server-side
   * (the DEK never leaves Vault); the local provider unwraps with a previous
   * KEK and wraps with the current one.
   */
  rewrap?(wrapped: WrappedKey, context: string): Promise<WrappedKey>;
  /** Cheap local check; `true` means "may be stale, call rewrap" (Vault cannot tell without a call). */
  needsRewrap?(wrapped: WrappedKey): boolean;
}

export class SecretStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreConfigError";
  }
}

export class LocalKeyProvider implements KeyEncryptionProvider {
  readonly id = "local" as const;
  readonly #kek: Buffer;
  readonly #keyId: string;
  /** Retired KEKs kept for reads and rewrap during a rotation (ZERNFLOW_LOCAL_KEK_PREVIOUS). */
  readonly #previous: Map<string, Buffer>;

  constructor(kek: Buffer, keyId = "local:default", previous: { key: Buffer; keyId: string }[] = []) {
    if (kek.length !== 32) throw new SecretStoreConfigError("ZERNFLOW_LOCAL_KEK must decode to exactly 32 bytes");
    this.#kek = kek;
    this.#keyId = keyId;
    this.#previous = new Map();
    for (const p of previous) {
      if (p.key.length !== 32) throw new SecretStoreConfigError("ZERNFLOW_LOCAL_KEK_PREVIOUS must decode to exactly 32 bytes");
      if (p.keyId === keyId) throw new SecretStoreConfigError("ZERNFLOW_LOCAL_KEK_PREVIOUS_ID must differ from the current KEK id");
      this.#previous.set(p.keyId, p.key);
    }
  }

  #keyFor(keyId: string): Buffer {
    if (keyId === this.#keyId) return this.#kek;
    const prev = this.#previous.get(keyId);
    if (!prev) throw new SecretStoreConfigError(`unknown local KEK id ${keyId}`);
    return prev;
  }

  needsRewrap(wrapped: WrappedKey): boolean {
    return wrapped.keyId !== this.#keyId;
  }

  async rewrap(wrapped: WrappedKey, context: string): Promise<WrappedKey> {
    if (!this.needsRewrap(wrapped)) return wrapped;
    const dek = await this.unwrap(wrapped, context);
    try {
      return await this.wrap(dek, context);
    } finally {
      dek.fill(0);
    }
  }

  async wrap(dek: Buffer, context: string): Promise<WrappedKey> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#kek, iv);
    cipher.setAAD(Buffer.from(`zernflow:kek:v1|${context}`));
    const body = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { wrapped: Buffer.concat([iv, tag, body]).toString("base64"), keyId: this.#keyId, version: 1 };
  }

  async unwrap(wrapped: WrappedKey, context: string): Promise<Buffer> {
    const kek = this.#keyFor(wrapped.keyId);
    const raw = Buffer.from(wrapped.wrapped, "base64");
    if (raw.length < 12 + 16 + 1) throw new SecretStoreConfigError("wrapped key is malformed");
    const decipher = createDecipheriv("aes-256-gcm", kek, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`zernflow:kek:v1|${context}`));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class VaultTransitKeyProvider implements KeyEncryptionProvider {
  readonly id = "vault-transit" as const;
  readonly #addr: string;
  readonly #token: string;
  readonly #key: string;
  readonly #namespace?: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(opts: { addr: string; token: string; key: string; namespace?: string; fetch?: FetchLike; timeoutMs?: number }) {
    let url: URL;
    try {
      url = new URL(opts.addr);
    } catch {
      throw new SecretStoreConfigError("VAULT_ADDR is not a valid URL");
    }
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "vault"].includes(url.hostname) && !url.hostname.endsWith(".svc") && !url.hostname.endsWith(".internal")) {
      throw new SecretStoreConfigError("VAULT_ADDR must use https outside local/cluster-internal hosts");
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(opts.key)) throw new SecretStoreConfigError("VAULT_TRANSIT_KEY is invalid");
    if (!opts.token) throw new SecretStoreConfigError("VAULT_TOKEN is required");
    this.#addr = url.toString().replace(/\/$/, "");
    this.#token = opts.token;
    this.#key = opts.key;
    this.#namespace = opts.namespace;
    this.#fetch = opts.fetch ?? ((u, i) => fetch(u, i));
    this.#timeoutMs = opts.timeoutMs ?? 5000;
  }

  async #call(op: "encrypt" | "decrypt" | "rewrap", body: Record<string, unknown>) {
    const headers: Record<string, string> = { "X-Vault-Token": this.#token, "Content-Type": "application/json" };
    if (this.#namespace) headers["X-Vault-Namespace"] = this.#namespace;
    const res = await this.#fetch(`${this.#addr}/v1/transit/${op}/${this.#key}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new SecretStoreConfigError(`Vault transit ${op} failed with HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { ciphertext?: string; plaintext?: string; key_version?: number } };
    if (!json.data) throw new SecretStoreConfigError(`Vault transit ${op} returned no data`);
    return json.data;
  }

  async wrap(dek: Buffer, context: string): Promise<WrappedKey> {
    // `context` is sent as associated data only for derived keys; we bind the
    // context in the DEK layer's AAD instead so plain transit keys work.
    void context;
    const data = await this.#call("encrypt", { plaintext: dek.toString("base64") });
    if (!data.ciphertext?.startsWith("vault:v")) throw new SecretStoreConfigError("Vault transit returned malformed ciphertext");
    const version = Number(/^vault:v(\d+):/.exec(data.ciphertext)?.[1] ?? data.key_version ?? 0) || null;
    return { wrapped: data.ciphertext, keyId: `vault:${this.#key}`, version };
  }

  async unwrap(wrapped: WrappedKey, context: string): Promise<Buffer> {
    void context;
    if (wrapped.keyId !== `vault:${this.#key}`) throw new SecretStoreConfigError(`wrapped with a different Vault key (${wrapped.keyId})`);
    const data = await this.#call("decrypt", { ciphertext: wrapped.wrapped });
    if (!data.plaintext) throw new SecretStoreConfigError("Vault transit returned no plaintext");
    return Buffer.from(data.plaintext, "base64");
  }

  /** Vault cannot report staleness locally; the rewrap job compares versions after the call. */
  needsRewrap(wrapped: WrappedKey): boolean {
    return wrapped.keyId === `vault:${this.#key}`;
  }

  /** `POST /v1/transit/rewrap/:name` — re-encrypts under the latest key version inside Vault. */
  async rewrap(wrapped: WrappedKey, context: string): Promise<WrappedKey> {
    void context;
    if (wrapped.keyId !== `vault:${this.#key}`) throw new SecretStoreConfigError(`wrapped with a different Vault key (${wrapped.keyId})`);
    const data = await this.#call("rewrap", { ciphertext: wrapped.wrapped });
    if (!data.ciphertext?.startsWith("vault:v")) throw new SecretStoreConfigError("Vault transit returned malformed ciphertext");
    const version = Number(/^vault:v(\d+):/.exec(data.ciphertext)?.[1] ?? data.key_version ?? 0) || null;
    return { wrapped: data.ciphertext, keyId: wrapped.keyId, version };
  }
}

type Env = Record<string, string | undefined>;

/** Resolve the configured provider. Throws SecretStoreConfigError when unconfigured or unsafe. */
export function resolveKekProvider(env: Env = process.env): KeyEncryptionProvider {
  const configured = (env.SECRET_STORE_KEK_PROVIDER ?? "").trim();
  const choice = configured || (env.VAULT_ADDR && env.VAULT_TRANSIT_KEY ? "vault-transit" : env.ZERNFLOW_LOCAL_KEK ? "local" : "");
  if (choice === "vault-transit") {
    return new VaultTransitKeyProvider({
      addr: env.VAULT_ADDR ?? "",
      token: env.VAULT_TOKEN ?? "",
      key: env.VAULT_TRANSIT_KEY ?? "",
      namespace: env.VAULT_NAMESPACE || undefined,
    });
  }
  if (choice === "local") {
    if (env.NODE_ENV === "production" && env.ZERNFLOW_ALLOW_LOCAL_KEK !== "true") {
      throw new SecretStoreConfigError(
        "The local KEK provider is refused in production. Configure Vault Transit or set ZERNFLOW_ALLOW_LOCAL_KEK=true for single-node self-hosting.",
      );
    }
    const raw = Buffer.from(env.ZERNFLOW_LOCAL_KEK ?? "", "base64");
    const previous = env.ZERNFLOW_LOCAL_KEK_PREVIOUS
      ? [{ key: Buffer.from(env.ZERNFLOW_LOCAL_KEK_PREVIOUS, "base64"), keyId: env.ZERNFLOW_LOCAL_KEK_PREVIOUS_ID || "" }]
      : [];
    if (previous.length && !previous[0].keyId) throw new SecretStoreConfigError("ZERNFLOW_LOCAL_KEK_PREVIOUS_ID is required with ZERNFLOW_LOCAL_KEK_PREVIOUS");
    return new LocalKeyProvider(raw, env.ZERNFLOW_LOCAL_KEK_ID || "local:default", previous);
  }
  if (choice) throw new SecretStoreConfigError(`Unknown SECRET_STORE_KEK_PROVIDER "${choice}"`);
  throw new SecretStoreConfigError("Secret store is not configured (set Vault Transit or ZERNFLOW_LOCAL_KEK)");
}

/** Providers able to unwrap existing versions, keyed by provider id (supports migration between providers). */
export function secretStoreConfigured(env: Env = process.env): boolean {
  try {
    resolveKekProvider(env);
    return true;
  } catch {
    return false;
  }
}

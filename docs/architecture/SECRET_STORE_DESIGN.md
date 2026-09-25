# Secret Store Design

## 1. Scope

ZernFlow-held secrets only: browser credentials, browser session state (cookies/local storage), AI provider
keys, outbound webhook signing secrets, ZernFlow-executed provider application credentials, worker tokens
(stored as hashes, not in the secret store). **Provider OAuth tokens owned by Agent Social Gateway stay in the
Gateway/Vault** and are never copied into ZernFlow.

## 2. Cryptography (no custom primitives)

* Data encryption: **AES-256-GCM** (Node `crypto`), fresh random 256-bit DEK and 96-bit IV per version.
* Additional authenticated data: `zernflow:secret:v1|<workspace_id>|<secret_id>|<version>` — ciphertext cannot
  be moved between rows or tenants without failing authentication.
* Key wrapping — `KeyEncryptionProvider` interface:
  * `VaultTransitKeyProvider` (**production**): DEK wrapped/unwrapped by HashiCorp Vault Transit
    (`/v1/transit/encrypt/<key>` / `decrypt`). The root KEK never leaves Vault. Auth via a Vault token with a
    policy limited to `encrypt`/`decrypt` on that key (reuses existing Vault infrastructure).
  * `LocalKeyProvider` (**development / single-node self-hosted only**): AES-256-GCM key-wrap using a 32-byte
    KEK from `ZERNFLOW_LOCAL_KEK` (base64) — held in the runtime secret group, never in the database.
    Refused when `NODE_ENV=production` unless `ZERNFLOW_ALLOW_LOCAL_KEK=true` is explicitly set.
* `kek_provider` + `kek_key_id` + `kek_version` stored per version to support KEK rotation (Vault
  `rewrap`) and provider migration.

## 3. Data model and access control

* `secrets` — metadata. Members may `select` metadata of their workspace (redacted by design: no value column).
* `secret_versions` — ciphertext. **No grants to `anon`/`authenticated`; RLS enabled with no policies.**
  Only the service role (server code) reads it.
* `secret_access_events` — append-only audit (create, rotate, revoke, delete, resolve, resolve_denied),
  members may read their workspace's events; no client writes.
* All mutations go through server routes (`/api/v1/secrets*`) that check **owner** role, then use the service
  client. Values are accepted once (create/rotate) and are **never returned** by any browser API.

## 4. Runtime API (`lib/secrets/store.ts`)

```ts
createSecret({workspaceId, name, kind, provider, value, expiresAt, actor})
rotateSecret({workspaceId, secretId, value, actor})          // new version, old versions retained (revoked)
revokeSecret / deleteSecret (crypto-shred: ciphertext rows deleted, metadata tombstoned)
resolveSecret({workspaceId, secretId, purpose, identity})    // server-only; audits; updates last_used
```

`resolveSecret` requires a `SecretAccessIdentity` (`{type:'user'|'service'|'worker', id, scopes}`) and a
declared `purpose`; worker identities may only resolve secrets bound to the browser session of a task they
currently lease. Expired or revoked secrets fail closed with typed errors.

## 5. Operational rules

* Never log values; `lib/observability/log.ts` redacts keys matching secret patterns and known values.
* Rotation: `rotated_at`, `current_version`; expiry detection surfaces in System Health and notifications.
* Deletion: ciphertext deleted immediately (crypto-shred), metadata kept as `deleted` for audit.
* Migration of legacy plaintext columns (`workspaces.ai_api_key`, `late_api_key_encrypted`,
  `webhook_secret`, `channels.webhook_secret`): client read access revoked in 00030; a server-side migration
  action (`/api/v1/secrets/import-legacy`, owner-only) encrypts values into the store and nulls the column;
  final column drop happens in a later forward migration (see manifest §3).

### 5.1 KEK rotation runbook (`secrets.rewrap` task)

Rewrapping replaces each secret version's wrapped DEK with one wrapped by the *current* KEK. Plaintext
secret values are never touched (the DEK is unchanged), and ciphertext + AAD stay valid. Revoked versions
are skipped. Each update is compare-and-swap on the old `wrapped_dek`, so concurrent rotations cannot
clobber each other, and every rewrap writes a `secret_access_events` row
(`action=rewrap`, `actor_type=service`, `purpose=kek_rotation`, `detail={fromKeyId,toKeyId}`).
The task processes a bounded batch per tick and defers with a keyset cursor (`after:<uuid>|failed:<n>`), so it
fits the free-tier tick budget. It ends as failed (terminal) if any version could not be rewrapped.

Same-provider rotation only (local → local, or Vault key version → latest version). Moving between providers
(local → Vault) is a re-import, not a rewrap.

**Local KEK** (development / single-node):
1. Generate the new key: `openssl rand -base64 32`.
2. Move the current values to `ZERNFLOW_LOCAL_KEK_PREVIOUS` / `ZERNFLOW_LOCAL_KEK_PREVIOUS_ID`.
3. Set the new `ZERNFLOW_LOCAL_KEK` and a **different** `ZERNFLOW_LOCAL_KEK_ID`. Deploy. New writes use the new key;
   reads of old versions use the previous key.
4. Per workspace, start `secrets.rewrap` (Jobs → Start task, owner only). Re-run it until the result reports
   `failed: 0`.
5. Check: `select count(*) from secret_versions where kek_provider = 'local' and kek_key_id = '<old id>' and revoked_at is null` returns 0.
6. Remove `ZERNFLOW_LOCAL_KEK_PREVIOUS*` and deploy.

**Vault Transit** (production):
1. `vault write -f transit/keys/<VAULT_TRANSIT_KEY>/rotate`. Old key versions still decrypt.
2. Run `secrets.rewrap` per workspace until `failed: 0`. It calls `transit/rewrap/<key>`, so plaintext DEKs
   never leave Vault. Check: `select count(*) from secret_versions where kek_provider = 'vault-transit' and
   kek_version < <latest> and revoked_at is null` returns 0.
3. Only then raise `min_decryption_version` on the transit key. Raising it earlier makes older secrets unreadable.

Rollback: before step 6 (local) or step 3 (Vault) nothing is lost. Restore the previous environment values and
redeploy, because versions wrapped by either key remain readable.

## 6. Threats addressed

Database dump without Vault → ciphertext only. Cross-tenant row swap → AAD failure. Browser XSS → no API
returns values. Compromised remote worker → only secrets of its current lease, only while leased, audited.

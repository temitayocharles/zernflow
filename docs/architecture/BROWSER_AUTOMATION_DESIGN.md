# Managed Browser Execution Design

## 1. Policy

* Only for **legitimate, user-owned accounts** where the official API/Gateway cannot perform the operation.
* Execution priority: official API → Gateway/OAuth adapter → browser. The resolver
  (`lib/browser/resolve.ts`) returns the first capable executor and the reason others were skipped.
* **Never bypass CAPTCHA, MFA, checkpoints, rate limits or anti-abuse systems.** Detection of any challenge
  stops the action, marks the session `challenge_required`/`mfa_required`, and moves the task to
  `waiting_for_user` with an intervention request.
* The owner must attest permitted use per session (`permitted_use_confirmed`) before any execution.
* Adapter capabilities are declared with a verification level: `verified` (live acceptance recorded),
  `experimental` (requires explicit workspace opt-in + task approval), `unsupported`.

## 2. Components

```
ZernFlow (control plane)                           Browser executor (Northflank free job / K3s)
 browser_sessions  ◄──── status/receipts ─────────  runner loop (concurrency 1, idle shutdown)
 tasks(mode=browser) ── lease via worker API ─────►  adapter registry (per platform)
 secret store ── storage state (leased task only) ─►  Playwright persistent context (isolated profile dir)
 artifacts ◄──── presigned PUT (screenshots/trace) ─  timeout policy, resource limits
```

* Worker API (`/api/worker/v1`): `claim` → `session` (GET decrypted storage state for the leased task only) →
  `heartbeat` → `artifacts` (presigned upload) → `complete` / `fail` (with error class, session status
  update, new storage state to re-encrypt). Tokens are hashed at rest, scoped to modes and optionally
  to a workspace.
* Adapter contract (`lib/browser/contract.ts`): `platform`, `capabilities[]` with verification level,
  `detectSessionState(page)`, `execute(operation, page, input, ctx)`. Selectors live **only** in the
  adapter's `selectors.ts`; business logic never references selectors.
* Runtime (`workers/browser-executor`): Playwright `chromium.launchPersistentContext` per session profile in
  a temp dir, storage state restored from the secret store, `--disable-dev-shm-usage`, per-action timeout,
  total task timeout, max pages, download dir confined to the task dir; trace + screenshots on failure.

## 3. Session lifecycle

`human_login_required` → (operator runs `interactive login` locally or via VNC-less manual export and uploads
storage state as a secret; or completes MFA in the provider UI) → `healthy` → periodic `session_check` task
(scheduled) → `degraded`/`expired`/`challenge_required` → notification + reauth prompt → `revoked` by owner
(storage state crypto-shredded).

## 4. Records

Every browser action creates an `execution_record` (mode `browser`, provider = platform, operation, attempt,
latency, error class, retry decision, artifact ids). Screenshots/traces are stored as artifacts with the
execution retention (`MAX_ARTIFACT_RETENTION_DAYS`).

## 5. Initial adapters

* `session_check` capability for `facebook_profile` and `tiktok_web`, both `experimental`, selector maps
  isolated, contract-tested against HTML fixtures with a fake page. Publishing capabilities are declared
  `unsupported` until live acceptance evidence exists — the system does not claim them.

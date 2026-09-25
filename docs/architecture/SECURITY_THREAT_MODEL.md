# Security Threat Model

Assets: tenant data (contacts, conversations, CRM), provider account control, secrets, browser sessions,
artifacts, execution integrity (no duplicate/forged external actions).

Actors: anonymous internet user; self-registered user (any sign-up gets an owned workspace); workspace
member; workspace owner; compromised browser (XSS); compromised remote worker; malicious webhook sender;
malicious uploaded file; database dump holder.

## Threats and controls

| Threat | Control | Status |
| --- | --- | --- |
| Cross-tenant job injection via `scheduled_jobs` | Client grants revoked; RLS no client policies; broadcast scheduling via `schedule_broadcast_delivery` RPC with membership + ownership checks | Fixed 00030 |
| Gateway account import across tenants | `gateway_workspace_bindings` + env binding; unique projection of a gateway account; webhook ignores unbound workspaces | Fixed 00030 + code |
| Cross-tenant flow/sequence execution (`goToFlow`, `enrollSequence`) | Workspace-scoped loads | Fixed |
| Cross-tenant references in legacy tables | `enforce_workspace_consistency` triggers | Fixed 00030 |
| SSRF (flow HTTP node, knowledge, any URL fetch) | `lib/security/safe-fetch.ts`: http(s) only, DNS resolution with private/link-local/loopback/CGNAT/metadata blocking, no redirects, timeout, response cap, header allowlist | Fixed |
| Secret leakage to browser | Column grants revoked; minimal workspace props; secret APIs never return values | Fixed |
| Secret leakage in logs | Redacting logger; no values in errors | Implemented |
| Cron secret in URLs / timing | Header only; constant-time compare | Fixed |
| Webhook forgery/replay | HMAC over raw body, 5-min window, event-id ledger (existing) | Existing |
| Duplicate external execution | Idempotency keys per task/variant/version; unique `(workspace_id, idempotency_key)`; lease-based claims; `unknown_outcome` → human reconciliation instead of blind retry | Implemented |
| Malicious uploads | MIME allowlist (no SVG/HTML), size limit, checksum verify, server-generated keys, private bucket, presigned URLs, `quarantined` state | Implemented |
| Path traversal | No user input in object keys or filesystem paths; browser worker confines downloads to task temp dir | Implemented |
| Cross-tenant object access | Artifact row lookup scoped by workspace before presign | Implemented |
| Browser-session theft | Storage state encrypted in secret store; only leased task can fetch; audit; revoke crypto-shreds | Implemented |
| Compromised worker token | Hashed at rest, scoped modes/workspace, revocable, lease-bound secret access, `last_seen` | Implemented |
| Privilege escalation (member → owner actions) | Owner checks on secrets, sessions, bindings, approvals, schedule management; DB guards for approvals | Implemented |
| Unsafe redirects | Auth callback `next` param restricted to relative paths (existing); worker/presign URLs server-built | Reviewed |
| CAPTCHA/MFA bypass | Policy + adapter contract: challenge → stop → `waiting_for_user` | By design |
| Database dump | Envelope encryption with KEK in Vault | Implemented |

## Service-role and worker privileges

* Service role is used only in server routes after authentication/authorization, cron routes (CRON_SECRET),
  the webhook receiver (HMAC) and the worker API (hashed token). New RPCs `claim_tasks`,
  `recover_expired_task_leases`, `materialize_due_schedules`, `complete_task`, `fail_task` are granted to
  `service_role` only; Supabase default `authenticated`/`anon` execute grants are explicitly revoked.
* Remote workers never receive database, Vault or storage root credentials.

## Residual risks / required production certification

* Open sign-up: recommended to disable public sign-up in Supabase for single-operator deployments.
* Gateway deployment credential is still deployment-wide; the binding limits projection to one workspace.
  Multi-tenant Gateway use requires per-workspace Gateway workspace refs (Gateway change).
* Browser adapters are `experimental` until live acceptance.

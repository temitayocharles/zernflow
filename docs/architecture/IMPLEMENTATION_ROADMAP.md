# Implementation Roadmap

Slices are vertical (schema → server → API → UI → tests) and independently shippable. Status is tracked in
`docs/EXECUTION_LEDGER.md`.

| Slice | Goal | Depends on | Exit criteria |
| --- | --- | --- | --- |
| R0 | Audit + architecture package (this folder) | — | 11 documents committed |
| R1 | **P0 security**: S1–S9 fixes, SSRF-safe fetch, AI node via Gateway, dead code removal (knip evidence) | R0 | Migration 00030 + tests: job RLS denial, integrity triggers, column grants, binding; unit tests for safe-fetch, cron auth, tenancy |
| R2 | **Execution plane**: tasks/events/schedules/execution records/worker identities, claim & lease RPCs, retry taxonomy, `/api/cron/tick`, worker API, Jobs UI (list, detail, dead letters, retry/cancel/approve) | R1 | Restart-safe lease recovery + idempotency tests in PGlite |
| R3 | **Secret store**: envelope encryption, Vault Transit + local KEK providers, audit, Secrets UI (redacted), legacy import | R1 | Crypto round-trip, AAD tamper, cross-tenant, no-value-returned API tests |
| R4 | **Campaign OS + publishing**: campaigns, content/variant publish states, scheduling RPC → publish tasks, executor chain (Gateway capability → browser → waiting_for_user), Campaigns/Content/Calendar UI | R2 | State machine + summary + scheduling idempotency tests |
| R5 | **Artifacts**: S3-compatible store, upload/complete/presign, retention, Assets UI | R1 | MIME/size/checksum/key isolation tests |
| R6 | **Browser plane**: browser sessions, adapter contract + registry + resolver, worker package with Playwright runtime, session-check adapters (experimental), Browser Sessions UI | R2, R3, R5 | Contract tests with fixtures; no-bypass policy tests |
| R7 | **Control plane**: navigation IA, Dashboard, System Health, Audit Log | R2–R6 | Navigation reflects product model |
| R8 | Consolidate `scheduled_jobs` job types into `tasks`; Zernio stage 2 removal; regenerate DB types | R2 + runtime evidence | Dual-run parity; operator confirmation |
| R9 | Campaign attribution in inbox/contacts (UTM → lead source → campaign), analytics consolidation, engagement watchers (comment volume per campaign) | R4 | Attribution visible in Customer 360 |
| R10 | Gateway publishing contract (when Gateway exposes it) → mark capabilities verified after live acceptance | Gateway | Live acceptance evidence |

## Implementation discipline per slice

typecheck · lint (no new warnings) · vitest (unit + PGlite SQL + DOM) · Next build · migration executed in
full-history harness · tenant isolation test · authorization test · failure-path test.

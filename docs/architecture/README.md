# ZernFlow Architecture

ZernFlow is being consolidated from a DM-automation/CRM tool into a self-hosted social/creator operating
system: persistent campaigns, publishing and scheduling, comment/DM automation, omnichannel inbox,
Customer 360, durable jobs, a secret store, and managed browser execution. It runs on zero-cost
infrastructure. Agent Social Gateway remains the provider boundary.

| Document | Purpose |
|---|---|
| [CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md) | Audit of the code as found: subsystems, KEEP/CONSOLIDATE/REFACTOR/REPLACE/REMOVE/UNKNOWN, security findings S1–S9 |
| [DEAD_CODE_AND_REMOVAL_MANIFEST.md](DEAD_CODE_AND_REMOVAL_MANIFEST.md) | Evidence-backed removal candidates and staged Zernio removal |
| [TARGET_ARCHITECTURE.md](TARGET_ARCHITECTURE.md) | Target domains, runtime topology on the free tier, budget guards |
| [DOMAIN_MODEL.md](DOMAIN_MODEL.md) | Entities, ownership, state machines |
| [EXECUTION_MODEL.md](EXECUTION_MODEL.md) | Durable tasks, schedules, leases, retries, worker API |
| [SECRET_STORE_DESIGN.md](SECRET_STORE_DESIGN.md) | Envelope encryption with a Vault Transit KEK |
| [BROWSER_AUTOMATION_DESIGN.md](BROWSER_AUTOMATION_DESIGN.md) | Playwright executor job, adapter contracts, human handoff |
| [ARTIFACT_STORAGE_DESIGN.md](ARTIFACT_STORAGE_DESIGN.md) | S3-compatible artifact store |
| [SECURITY_THREAT_MODEL.md](SECURITY_THREAT_MODEL.md) | Threats and controls |
| [MIGRATION_PLAN.md](MIGRATION_PLAN.md) | Forward migrations 00030+, deploy procedure, verification SQL |
| [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) | Slices R0–R10 and per-slice discipline |

Progress, deferrals and operator actions are tracked in [`../EXECUTION_LEDGER.md`](../EXECUTION_LEDGER.md).

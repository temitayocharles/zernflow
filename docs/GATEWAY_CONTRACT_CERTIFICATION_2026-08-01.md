# Agent Social Gateway Contract Certification

Date: 2026-08-01
Branch: `feature/gateway-contract-certification`

## Architecture boundary

ZernFlow remains the operator shell. Agent Social Gateway remains the provider account, webhook, event, durable action and MCP control plane. This certification does not alter that boundary.

## Contract coverage

The `AgentSocialGatewayHttpAdapter` is covered against the canonical REST contract for:

- provider profile listing;
- provider connection initiation;
- account listing and disconnect;
- account-scoped conversation listing;
- conversation message reads and sends;
- public and private comment reply routes;
- delivery webhook creation and update;
- server-side `X-API-Key` authentication;
- `no-store` request caching;
- structured error responses that do not expose the API key.

## Validation evidence

Executed against commit `abcc25e9f78ef793c966ad308be0dbaa2647ac8e`:

- focused gateway adapter suites: 14 tests passed;
- ESLint: 0 errors, 46 pre-existing warnings;
- Next.js 16.2.12 production build: passed;
- TypeScript production build check: passed;
- production dependency audit: 0 high and 0 critical findings.

The npm install reports development-tree advisories, but `npm audit --omit=dev` reports zero production vulnerabilities. The existing lint warnings remain tracked separately and do not represent new errors introduced by this contract certification.

## Remaining acceptance boundary

This contract certification proves static and mocked HTTP compatibility. Live acceptance still requires a deployed gateway and worker, runtime secrets injected from Vault, one real provider account, inbound event visibility in the ZernFlow inbox, an outbound action, human takeover and an audit trail.

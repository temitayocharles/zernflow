# Milestone 2 Evidence: Runtime Secret Boundary

Date: 2026-08-01
Branch: `feature/vault-managed-secrets`

## Change

ZernFlow no longer accepts, stores, reads or returns social-provider, gateway,
webhook-signing or AI credentials through workspace/channel rows.

Runtime-only inputs:

- `SOCIAL_GATEWAY_DRIVER`
- `SOCIAL_GATEWAY_BASE_URL`
- `SOCIAL_GATEWAY_API_KEY`
- `SOCIAL_GATEWAY_WEBHOOK_SECRET`
- `AI_GATEWAY_API_KEY`
- temporary compatibility-only `ZERNIO_API_KEY`

These values are intended to be injected by Vault through External Secrets. The
browser settings page exposes only configured/not-configured status.

## Database migration

`00016_vault_managed_runtime_secrets.sql` clears and drops:

- `workspaces.late_api_key_encrypted`
- `workspaces.ai_api_key`
- `workspaces.webhook_secret`
- `channels.webhook_secret`

No legacy database value is used as a fallback after the migration.

## Gateway client

`AgentSocialGatewayHttpAdapter` implements the provider-neutral contract over
an authenticated HTTP boundary. `@zernio/node` remains isolated in the temporary
compatibility adapter and is selected only when `SOCIAL_GATEWAY_DRIVER=zernio`.

## Security properties

- UI and API routes cannot write raw provider/AI secrets to Supabase.
- Gateway calls authenticate with `X-API-Key` injected server-side.
- Webhook verification fails closed when the runtime signing secret is absent.
- Gateway error objects do not contain the configured API key.
- Database dumps after migration contain no provider/AI secret columns.

## Validation gate

The milestone is accepted only after:

- production dependency audit reports zero high/critical findings;
- TypeScript passes;
- tests pass;
- lint reports no errors;
- the Next.js production build passes;
- the branch CI passes before merge.

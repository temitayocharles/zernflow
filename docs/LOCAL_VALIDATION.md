# Local validation

Use Node 24 and npm 11 (as CI does), then `npm ci`, `npm run lint`,
`npm run typecheck`, `npm test`, and `npm run build`.
Inter is bundled from the OFL-licensed `@fontsource-variable/inter` package;
production builds no longer fetch fonts from Google.

## Legacy smoke safety

`scripts/smoke-test.mjs` exercises the **legacy Zernio webhook** and does not
certify Gateway-backed delivery. It writes and deletes data and may cause
outbound messages. Never point it at a production tenant or provider account.
No default application, workspace or account is supplied anymore.

For an isolated, disposable Supabase/app/provider environment only, configure:

- `SMOKE_ALLOW_WRITES=disposable-environment-only`
- `SMOKE_BASE_URL` (explicit application origin)
- `SMOKE_WORKSPACE_ID` (test workspace UUID)
- `SMOKE_CHANNEL_ID` (test Telegram channel UUID)
- `SMOKE_ACCOUNT_ID` (that channel's external account identity)
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Existing legacy webhook configuration required by the script and deployment.

Run `node scripts/smoke-test.mjs`. URL and tenant inputs are validated before
client creation; the channel/workspace/account relationship is checked before
setup writes. This is an operator acknowledgement, not proof the target is
disposable: independently verify both URLs and credentials refer to test systems.
Do not commit environment values. The script optionally reads `.env`, but it
also accepts process environment configuration without an environment file.

Gateway live acceptance still requires signed real inbound events, account
scoping verification, and durable outbound operation confirmation. It cannot
be inferred from legacy smoke or mocked unit tests.

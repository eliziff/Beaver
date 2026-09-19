# End-to-end CI

The separate CI dependency audit checks all three lockfiles (root, backend and
frontend; the Word surface shares the frontend). It uses npm's bulk advisory
service with an OSV fallback and fails closed when neither answers. Exceptions
must identify an advisory and reason in `scripts/audit-allowlist.json`; no
upstream exceptions are inherited. Its offline regression gate is
`node --test scripts/audit-gate.test.mjs`.

Cloud SAML sign-in uses GoTrue's configured providers. Set `SSO_ENABLED=true`
and optionally restrict `SSO_ALLOWED_DOMAINS` to comma-separated DNS domains.
Login starts with an email and redirects configured domains to their provider;
other domains continue to password login. Provider outages stay visible rather
than silently falling back. Register Beaver's existing `/auth/callback` URL
with the provider. Account-free local use needs no SSO configuration.

MCP connectors accept generic OAuth clients plus separate `SLACK_MCP_OAUTH_*`
and `GOOGLE_MCP_OAUTH_*` client IDs, secrets, scopes and confidential-origin
allowlists (see `backend/.env.example`). Every discovered endpoint must be on
the selected client's allowlist before credentials are supplied. Register
`PUBLIC_ORIGIN/api/user/mcp-connectors/oauth/callback` with the provider.
For [Slack](https://docs.slack.dev/ai/slack-mcp-server), enable its MCP server and
PKCE in the Slack app and connect to `https://mcp.slack.com/mcp`. Google consent
adds `access_type=offline` and `prompt=consent` for durable refresh tokens,
following [Google's OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server).
These settings reuse the existing encrypted token storage and refresh flow.

`.github/workflows/e2e.yml` is the production-path browser gate. It runs on
pull requests to `main` and `upstream-main`, and can be started manually.

The job:

1. installs root, backend, and frontend dependencies;
2. starts disposable MinIO and Supabase services;
3. applies the sole fresh-database contract, `backend/schema.sql`;
4. writes server-only configuration to `backend/.env`;
5. builds the Vite client and backend;
6. starts one production Beaver origin on port 3000; and
7. drives Chromium with Playwright, preserving reports and traces.

The backend serves both `frontend/dist` and `/api`. There is no frontend
server, build-time public environment file, CORS path, or alternate API URL.

## Model-dependent cases

The suite is useful without a paid model key. Tests that require generation
skip unless a maintainer starts the workflow manually and the repository has
an `ANTHROPIC_API_KEY` Actions secret. Pull requests run only the deterministic
remainder so changed code cannot read the provider credential.

Add the optional secret under **Settings > Secrets and variables > Actions**,
or with:

```bash
gh secret set ANTHROPIC_API_KEY --repo OWNER/REPO
```

Never put the key in workflow source, fixtures, artifacts, or logs.

## Make the gate mandatory

Require the `e2e / playwright` status check in the `main` branch-protection
rule after its first successful run. Also require the backend and frontend CI
jobs.

## Run locally

Start disposable Supabase and S3-compatible storage, populate `backend/.env`,
then run:

```bash
npm ci
npx playwright install --with-deps chromium
npm run test:e2e
```

`PLAYWRIGHT_BASE_URL` defaults to `http://localhost:3000`. Browser tests must
use synthetic or public documents and disposable credentials.

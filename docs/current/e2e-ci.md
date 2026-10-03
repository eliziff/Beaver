# End-to-end CI

The separate CI dependency audit checks changed manifests/lockfiles (root, backend
and frontend; the Word surface shares the frontend), plus all three weekly and
on manual CI runs. Changes to its gate or allowlist also audit all three. It uses npm's bulk advisory
service with an OSV fallback and fails closed when neither answers. Exceptions
must identify an advisory and reason in `scripts/audit-allowlist.json`; no
upstream exceptions are inherited. Its offline regression gate is
`node --test scripts/audit-gate.test.mjs`.

CI selects jobs from the complete Git diff, including deleted files and both
sides of moves. Documentation-only changes skip application builds and browser
tests. Ordinary backend changes skip frontend unit tests and lint; shared inputs and the
backend helpers imported by frontend tests still validate both. Unknown inputs
run both surfaces. Grammar, source-boundary, export-integrity and frontend tooling
checks run separately from focused behavior tests. The TypeScript identifier-count
heuristic is an optional maintenance tool, not a test gate. New commits cancel
superseded CI runs.

The main CI coordinates the backend, browser and Authorities parity gates. One
Ubuntu 24.04 job supplies the native addon to all three. Its exact cache key
includes committed addon/parser build inputs, root Cargo configuration and `rustc -vV`;
workflow or documentation-only parser pin changes reuse the addon. There are
no fallback cache keys. Each consumer downloads the artifact from the same run.
The backend and frontend jobs also upload their compiled outputs for browser
gates in the same run. Authorities parity keeps its native semantic, package and
browser checks; it no longer repeats the main unit suites or TypeScript builds.
Its focused Vite harness consumes backend output, without downloading or waiting
for an unused frontend production build. E2E uses the production frontend artifact
and does not install frontend dependencies unless a manual run must build it.
Standalone manual e2e/parity runs build their own outputs and addon. Release/source-gold and
native citation/quotation tests remain independent behavior gates.

Frontend CI installs root shared dependencies and frontend dependencies, without
installing the backend. Shared TypeScript contracts and PDF helpers live in
`shared/contracts/`; `npm run build:shared` produces ignored runtime modules and
declarations in `shared/runtime/`. Production build/dev commands compile that
owner first. Vitest resolves those modules to their TypeScript sources directly;
focused tests do not compile shared output or build the application/native addon.
Packaging and direct compiled-runtime commands need the shared build once.
Both standalone entries are built together, so the frontend build uses one
application pass and one standalone pass.

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

`.github/workflows/e2e.yml` is the production-path browser gate. CI calls it for
application pull requests to `main` and `upstream-main`; it can also be started manually.

UI-only changes run the account-free production application with a disposable
local store. Eleven browser checks cover responsive navigation, persisted chat
lifecycle/selection and project operations. No Supabase or MinIO is started.
Auth, API/persistence, schema, deployment and unknown infrastructure inputs keep
the complete cloud browser and live persistence/RLS/S3 suite. Manual runs retain
the cloud gate. `scripts/ci-scope.py` owns routing; mixed changes keep the broader gate.

Both modes install locked dependencies, download the main CI build artifacts,
start one production Beaver origin on port 3000, and drive Chromium. Standalone
manual runs build locally. The cloud mode additionally starts disposable MinIO
and Supabase and applies `backend/schema.sql` before its persistence checks.

The ordinary backend suite excludes real Word-runtime tests; the Word workflow
runs all fifteen suites with pinned Python requirements and LibreOffice.
Word/Python runtime, dependency and platform changes keep Linux, Windows, macOS
and the isolated container gate. Shared contracts and application orchestration
use the Linux native runtime only. Documentation-only legal-structure changes
skip Cargo; PDF Inspector guidance edits run the merge-guidance proof without
Windows corpus preflight. Parser/candidate changes keep the source-gold gate.

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

To use the existing local production build for the small browser suite, set
`CI=true`, `BEAVER_E2E_MODE=local` and `PLAYWRIGHT_BASE_URL` to its origin, then run
`npx playwright test`. Use an isolated `MIKE_LOCAL_DATA_DIR` for the test server.

## Local resource use

Local Vitest runs use one isolated thread worker; CI uses four. Pure Node tests skip React/JSDOM
setup. Normal npm builds/tests run below normal priority and limit Rayon/OpenMP
pools to one thread. Root Cargo configuration limits compilation to one job
and one codegen unit, including addon builds launched from this checkout.
Native CI commands explicitly use two jobs on their dedicated runners.
Avoid running builds and tests concurrently on the workstation; use focused tests
and reuse built production assets for browser checks. Full Rust builds belong in
CI unless native source changed and a local integration build is necessary.

Frontend Vite and Vitest read shared contracts from source; no shared build is
needed. Backend focused tests do the same and use the SQLite worker's existing
source mode, without generating test-only JavaScript copies. Frontend type checks are incremental. Use
`npm run check --prefix frontend` to check types, `npm run build:app --prefix
frontend` or `npm run build:standalone --prefix frontend` for one production
surface in `frontend/.tmp/`, and the ordinary build for the complete release.

To run the real Word suite locally after installing its prerequisites, set
`BEAVER_WORD_INTEGRATION=1` and run `npm test --prefix backend`.

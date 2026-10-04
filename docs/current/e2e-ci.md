# End-to-end CI

The dependency audit uses npm's standard lockfile audit for changed dependencies,
plus the weekly and manual runs. High and critical advisories block; no custom
advisory client, retry/canary harness or exception allowlist is maintained.

CI selects jobs from the complete Git diff, including deleted files and both
sides of moves. Documentation-only changes skip application builds and browser
tests. Blanket unit suites are not CI gates. Focused tests name exact files; production
browser checks exercise the actual application. Backend changes skip frontend lint;
shared inputs still build both surfaces. Unknown inputs
run both surfaces. Grammar checks belong to their native owners; export-integrity
checks run when that contract changes. Frontend
tooling checks exercise the build/transport helpers. New commits cancel
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
installing the backend. Frontend builds, development and Vitest read shared
TypeScript directly; focused tests do not build the application/native addon.
Backend production emission builds ignored shared runtime modules once. CI stages
Beaver alone; Word and standalone outputs have explicit build commands.

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

UI and ordinary application-operation changes run the account-free production
application with a disposable local store. Seventeen browser checks cover responsive navigation, persisted chat
lifecycle/selection, project operations, workflow editing/read-only built-ins
and tabular review creation/document uploads. No Supabase or MinIO is started.
Auth, persistence adapters, cloud/storage composition, schema, deployment and
unknown infrastructure inputs keep
the complete cloud browser and live persistence/RLS/S3 suite. Manual runs retain
the cloud gate. `scripts/ci-scope.py` owns routing; mixed changes keep the broader gate.

Both modes install locked dependencies, download the main CI build artifacts,
start one production Beaver origin on port 3000, and drive Chromium. Standalone
manual runs build locally. The cloud mode additionally starts disposable MinIO
and Supabase and applies `backend/schema.sql` before its persistence checks.

Cloud browser workers each create one account/session and delete their account
on teardown. Auth lifecycle cases own separate accounts. CI uses two isolated
cloud workers; local mode keeps one backend owner and one worker. Retries do not
hide failures, and no shared authentication file is staged on disk.

The ordinary backend suite excludes real Word-runtime tests; the Word workflow
runs all fifteen suites with pinned Python requirements and LibreOffice.
Word/Python runtime and platform changes run Linux in the cached container and
Windows natively. Linux installs no second host Python/LibreOffice runtime and
runs the fifteen suites once. Dockerfile-only changes run Linux. Word application and
artifact-reference changes use the Linux runtime; unrelated shared contracts,
generic chat orchestration and package edits do not replay Word integration.
Documentation-only legal-structure changes
skip Cargo. PDF Inspector documentation, CLI and upstream-update tooling changes
do not run the Windows corpus gate; Inspector library and CMap changes retain
one real extraction/source-gold gate.

Native CI reuses the exact addon when its build-input cache hits, and restores
compiled Rust dependencies on a miss. Standalone manual browser gates restore
those dependencies too; a source edit need not start from an empty Cargo target.

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

Ordinary browser checks use the disposable account-free local store. Run:

```bash
npm ci
npx playwright install --with-deps chromium
npm run test:e2e
```

`PLAYWRIGHT_BASE_URL` defaults to `http://localhost:3000`. Browser tests must
use synthetic or public documents and disposable credentials.

`npm run test:e2e`, headed/UI variants and plain
`npx playwright test` default to local mode without Docker or Supabase.
Cloud checks are explicit: `npm run test:e2e:cloud` starts/resets disposable
Supabase and passes its settings through inherited environment variables,
without editing `backend/.env` or creating backup files. Configure disposable
S3-compatible storage for that cloud run. CI selects its mode explicitly.
The launcher owns `.tmp/playwright-local`, clears it before launch and removes it
after server shutdown. It refuses to reuse servers on ports 3000/3001. An abruptly
killed run leaves this one bounded directory for cleanup on the next launch.

To use the existing local production build for the small browser suite, set
`CI=true`, `BEAVER_E2E_MODE=local` and `PLAYWRIGHT_BASE_URL` to its origin, then run
`npx playwright test`. Use an isolated `MIKE_LOCAL_DATA_DIR` for the test server.

## Local resource use

Source-test edits do not start application CI. Focused source checks remain local;
there is no unit-test matrix, lint or build-tool test gate in application CI. Grammar
validation belongs to its engine owner, rather than every backend build. Real
browser, corpus and Word runtime gates remain; mixed implementation/test edits
retain application checks. Authorities parity
follows its specific shared contracts and PDF dependencies, not every contract.

Backend source commands and inherited Node workers reuse TSX transformations in
ignored `.tmp/node/`; TSX expires old cache entries itself. No command disables
that cache or creates a separate per-task transformation directory.

Frontend source checks run in Node with one isolated worker, without React or
DOM setup. Backend source checks use one worker locally and in CI. Normal
npm builds/tests run below normal priority and limit Rayon/OpenMP
pools to one thread. Root Cargo configuration limits compilation to one job
including addon builds launched from this checkout.
Native CI commands explicitly use two jobs on their dedicated runners.
Local addon builds use the incremental development profile; launchers select
the newest built artifact. Release optimization is explicit delivery work.
Avoid running builds and tests concurrently on the workstation; use focused tests
and reuse built production assets for browser checks. Full Rust builds belong in
CI unless native source changed and a local integration build is necessary.

Frontend Vite and Vitest read shared contracts from source; no shared build is
needed. Backend focused tests do the same and use the SQLite worker's existing
source mode, without generating test-only JavaScript copies. Frontend type checks are incremental. Use
`npm run check --prefix frontend` to check types, `npm run build:app --prefix
frontend` or `npm run build:standalone --prefix frontend` for one production
surface in `frontend/.tmp/`. The ordinary build stages Beaver only. `build:word`
stages Word separately; `build:deploy` replaces served Beaver and Word output
together while the service is stopped. CI's browser job installs the staged
Beaver artifact into its isolated server's `frontend/dist/`.

To run the real Word suite locally after installing its prerequisites, set
`BEAVER_WORD_INTEGRATION=1` and run `npx vitest run` from `backend/`.


Production browser smoke uses the root Node Playwright installation: `npm run test:browser`
checks the running launcher-owned app without building it. Focus it with
`npm run test:browser -- sources-browser.spec.ts`, `authorities-browser.spec.ts`,
`court-records-browser.spec.ts`, or the explicitly opt-in live `tabular-browser.spec.ts`.
Tabular model calls require `BEAVER_BROWSER_LIVE=1`; FullSweep enables it only
inside its already authorized isolated browser step. Ordinary smoke skips them. The Court Records alias
also consumes the existing running app; it no longer rebuilds standalone output.
Start an isolated production surface with the launcher before these checks; use
the local E2E lane for a development stack. The smoke flow owns and deletes the
records it creates, and Playwright overwrites its output directory on the next run.

The retained browser outcomes are explicit version-bound Sources membership,
organization review/accept/undo, nested output-folder selection, native Authorities
DOCX/PDF review and attachment reopening, independently inspected table/book
downloads, Tabular Run/Regenerate/design/import, and Court Records trusted exhibit
dragging plus independently inspected outputs for Alberta affidavit/appeal and
Federal Court/Federal Court of Appeal motion records. Repeated model answer and
provenance assertions remain in the live-tool integration lane; obsolete hard-coded
pilot inspection, ChromeDriver provisioning and fake research interop are gone.
`smoke/work-product-files.py` owns the disposable fixture generators and independent
PyMuPDF/python-docx output inspection; it starts no browser. The Authorities generator records public citation sources and distinguishes format-only
identifiers; its prose is invented test text, not judicial quotations.

For the standalone Court Records surface, explicitly build it once with
`npm run build:standalone --prefix frontend`, serve the existing
`frontend/.tmp/standalone-dist/` with a static server, and set
`PLAYWRIGHT_BASE_URL` to that server and `COURT_RECORDS_URL=/court-records.html`
when running `npm run test:court-records:browser`. This preserves the standalone
browser/output check without coupling every invocation to a frontend rebuild.

# End-to-end CI

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
skip unless the repository has an `ANTHROPIC_API_KEY` Actions secret. Fork pull
requests never receive that secret, so they run the deterministic remainder.

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

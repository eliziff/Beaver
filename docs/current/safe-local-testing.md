# Safe local testing

Use disposable infrastructure, low-limit model keys, and synthetic or public
documents until a deployment has been reviewed. Never test with privileged,
confidential, client, personnel, or firm knowledge-management material.

## Keep secrets on the server

The frontend has no environment file. It loads a strict public runtime object
from same-origin `GET /api/config`; cloud mode exposes only the Supabase URL and
publishable key. Privileged values belong in ignored `backend/.env`:

```env
AUTH_MODE=cloud
PUBLIC_ORIGIN=https://beaver.example
SUPABASE_URL=https://example.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_SECRET_KEY=your-service-role-key
```

Model-provider and object-storage credentials also stay in `backend/.env`.
Use separate test projects, buckets, accounts, and capped keys.

The authorized FullSweep uses port 3100 and a fresh data/launcher directory
under `.tmp/full-sweep/`. It stops its own surface afterward and leaves the
ordinary launcher and local data alone. A busy port fails the sweep. For manual
isolated runs, set `PORT`, `MIKE_LAUNCHER_STATE_DIR`, `OPEN_LEGAL_DATA_HOME` and
`MIKE_LOCAL_DATA_DIR`; the launcher, build guard and browser smoke use that port.

Before every test or commit, run `git status --short` and stop if an environment
file, credential, downloaded corpus, cache, or generated artifact is staged.

## Start with deterministic flows

Test account creation, projects, uploads, folders, downloads, and deletion
before adding a model key. Then add one disposable key and exercise the
assistant using synthetic documents.

Afterward, delete uploaded objects, database rows or the disposable project,
local environment files, and temporary keys. Verify deletion in both metadata
and object storage.

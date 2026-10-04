#!/usr/bin/env bash
# Explicit cloud E2E: start/reset disposable Supabase, then run Playwright.
# npm run test:e2e:cloud [-- PLAYWRIGHT_ARGS]
# Environment is inherited by the API/fixtures; backend/.env is never rewritten.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"

if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running — start it first (open -a Docker) and retry." >&2
    exit 1
fi

cd "$BACKEND"

if [ ! -f supabase/config.toml ]; then
    npx supabase init --force --with-vscode-settings=false ||
        npx supabase init --force
fi

# Idempotent: if the stack is already up this is a no-op.
npx supabase start

STATUS=$(npx supabase status -o json)
DB_URL=$(jq -r '.DB_URL' <<<"$STATUS")
API_URL=$(jq -r '.API_URL' <<<"$STATUS")
ANON_KEY=$(jq -r '.ANON_KEY' <<<"$STATUS")
SERVICE_KEY=$(jq -r '.SERVICE_ROLE_KEY' <<<"$STATUS")

echo "Resetting disposable E2E database and loading schema.sql…"
npx supabase db reset --no-seed
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f schema.sql
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "NOTIFY pgrst, 'reload schema';"

# Node's backend .env loader does not override inherited environment values.
export SUPABASE_URL="$API_URL"
export SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"
export SUPABASE_SECRET_KEY="$SERVICE_KEY"
export DATABASE_URL="${DB_URL}?sslmode=disable"
export AUTH_MODE=cloud
export BEAVER_E2E_MODE=cloud
# This suite checks application behavior, not request throttling.
for name in GENERAL AUTH CHAT CHAT_CREATE UPLOAD EXPORT DATA_DELETE; do
    export "RATE_LIMIT_${name}_MAX=100000"
done

echo "Local stack ready: $API_URL (db: ${DB_URL%%\?*})"

cd "$ROOT"
npx playwright test "$@"

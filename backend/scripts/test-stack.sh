#!/usr/bin/env bash
# Run the gated stack-level integration tests against a local Supabase stack.
#
# These tests exercise the REAL stack (GoTrue auth + Postgres RLS) instead of
# mocks. They are the harness you re-run on every Supabase image bump to prove
# the auth↔API contract and the deny-all RLS firewall still hold.
#
# Usage:  supabase start   # in the repo, once
#         npm run test:stack        (from backend/)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SCHEMA_FILE="$BACKEND_DIR/schema.sql"
FINGERPRINT_FILE="$SCRIPT_DIR/schema-fingerprint.sql"
RESET_TEST_SCHEMA="${BEAVER_RESET_TEST_SCHEMA:-false}"

if [[ "$RESET_TEST_SCHEMA" != "true" && "$RESET_TEST_SCHEMA" != "false" ]]; then
    echo "BEAVER_RESET_TEST_SCHEMA must be true or false." >&2
    exit 1
fi

if ! command -v supabase >/dev/null 2>&1; then
    echo "supabase CLI not found. Install: brew install supabase/tap/supabase" >&2
    exit 1
fi

STATUS="$(supabase status -o json 2>/dev/null)" || {
    echo "No running Supabase stack. Start one with: supabase start" >&2
    exit 1
}

read_key() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s)['$1']??'')))" <<<"$STATUS"; }

SUPABASE_TEST_URL="$(read_key API_URL)"
SUPABASE_TEST_SERVICE_ROLE_KEY="$(read_key SERVICE_ROLE_KEY)"
SUPABASE_TEST_ANON_KEY="$(read_key ANON_KEY)"
SUPABASE_TEST_DB_URL="$(read_key DB_URL)"

if [[ -z "$SUPABASE_TEST_URL" || -z "$SUPABASE_TEST_SERVICE_ROLE_KEY" || -z "$SUPABASE_TEST_ANON_KEY" || -z "$SUPABASE_TEST_DB_URL" ]]; then
    echo "Could not read API_URL/DB_URL/SERVICE_ROLE_KEY/ANON_KEY from 'supabase status'." >&2
    exit 1
fi
export SUPABASE_TEST_URL SUPABASE_TEST_SERVICE_ROLE_KEY SUPABASE_TEST_ANON_KEY SUPABASE_TEST_DB_URL

if ! command -v psql >/dev/null 2>&1; then
    echo "psql not found. Install PostgreSQL's client tools before running stack tests." >&2
    exit 1
fi

# Pin the disposable stack to both this schema source and its live catalog. This
# prevents a long-running local stack from silently exercising yesterday's schema.
SOURCE_FINGERPRINT="$(node -e "const{createHash}=require('node:crypto');const{readFileSync}=require('node:fs');process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1],'utf8').replace(/\\r\\n/g,'\\n')).digest('hex'))" "$SCHEMA_FILE")"
schema_fingerprint() {
    psql "$SUPABASE_TEST_DB_URL" -XAtq --set ON_ERROR_STOP=1 \
        --file "$FINGERPRINT_FILE" \
        | node -e "const{createHash}=require('node:crypto');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(createHash('sha256').update(s.replace(/\\r\\n/g,'\\n')).digest('hex')))"
}
load_schema() {
    if [[ "${1:-}" == "reset" ]]; then
        psql "$SUPABASE_TEST_DB_URL" -X --set ON_ERROR_STOP=1 \
            -c 'drop schema public cascade;' \
            -c 'create schema public;' \
            -c 'grant usage on schema public to anon, authenticated, service_role;'
    fi
    echo "Loading Beaver schema from $SCHEMA_FILE"
    psql "$SUPABASE_TEST_DB_URL" -X --set ON_ERROR_STOP=1 --file "$SCHEMA_FILE"
    psql "$SUPABASE_TEST_DB_URL" -Xq --set ON_ERROR_STOP=1 -c "NOTIFY pgrst, 'reload schema';"
    local marker="beaver-test-schema:$SOURCE_FINGERPRINT:$(schema_fingerprint)"
    psql "$SUPABASE_TEST_DB_URL" -Xq --set ON_ERROR_STOP=1 \
        -c "comment on schema public is '$marker';"
}

PROJECTS_TABLE="$(
    psql "$SUPABASE_TEST_DB_URL" -XAtq \
        -c "select to_regclass('public.projects');"
)"
if [[ "$RESET_TEST_SCHEMA" == "true" ]]; then
    load_schema reset
elif [[ "$PROJECTS_TABLE" != "projects" ]]; then
    load_schema
else
    SCHEMA_MARKER="$(psql "$SUPABASE_TEST_DB_URL" -XAtq --set ON_ERROR_STOP=1 \
        -c "select coalesce(obj_description('public'::regnamespace,'pg_namespace'),'');")"
    EXPECTED_MARKER="beaver-test-schema:$SOURCE_FINGERPRINT:$(schema_fingerprint)"
    if [[ "$SCHEMA_MARKER" != "$EXPECTED_MARKER" ]]; then
        echo "Beaver test schema drifted or predates fingerprinting." >&2
        echo "Re-run with BEAVER_RESET_TEST_SCHEMA=true to replace the disposable public schema." >&2
        exit 1
    fi
fi

echo "Running stack integration tests against $SUPABASE_TEST_URL"
cd "$BACKEND_DIR"
TESTS=(
    src/__tests__/integration/stack.supabase.test.ts
    src/__tests__/integration/access.supabase.test.ts
    src/lib/__tests__/relationalRepositories.postgres.test.ts
)
if [[ "${S3_CONTRACT_TEST:-false}" == "true" ]]; then
    TESTS+=(src/lib/__tests__/storage.test.ts src/lib/__tests__/documentApplication.test.ts)
fi
exec npx vitest run "${TESTS[@]}" "$@"

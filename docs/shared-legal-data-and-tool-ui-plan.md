# Shared legal data and tool UI plan

> Status note (2026-07-26): the architectural decisions here remain in force.
> Track implementation status and remaining integration work in the
> [Beaver master plan](beaver-master-plan.md).

## Decisions

1. `OpenLegalData/` owns provider storage, importers, schemas, health checks,
   and the localhost JSON interface.
2. SQLite is the runtime format. Parquet readers and analytical engines are
   optional importer dependencies only.
3. Windows data lives under
   `%LOCALAPPDATA%\OpenLegalProducts\LegalData`, overridable with
   `OPEN_LEGAL_DATA_HOME`.
4. Provider databases are independent immutable snapshots. App preferences,
   projects, and generated legal work product are not mixed into provider
   databases.
5. Table of Authorities has one browser UI. The standalone Python host serves
   the same static files that Beaver displays. The Tk UI becomes a frozen legacy
   fallback, not a second maintained renderer.
6. ALR Quote Verifier remains an independent application. Beaver does not
   import it, host its GUI, or require a fork. Only neutral provider data and
   selectively ported algorithms are reused.

The detailed storage rationale is in
`OpenLegalData/docs/ADR-0001-local-storage-and-runtime.md`.
The ALR ownership and reuse boundary is fixed in
`docs/alr-independence-and-shared-data-plan.md`.

## Storage contract

```text
OpenLegalProducts/LegalData/
  providers/
    a2aj/
      a2aj.sqlite
      snapshots/
    courtlistener/
      courtlistener.sqlite
      snapshots/
  cache/
    a2aj/
    courtlistener/
    tna/
    govuk-et/
    govinfo/
  apps/
    table-of-authorities/
      jobs/
      runtime/
    alr-quote-verifier/   # reserved for ALR-owned app state only
    mike/
```

Bulk import writes `*.new`, validates schema and counts, then atomically
replaces the live snapshot. Readers open databases read-only. Cache entries are
disposable and must never be the sole copy of user work.

## Runtime dependency policy

- OpenLegalData lookup and service code: Python standard library only.
- Beaver: Node 22 built-ins for direct SQLite fallback; no npm database driver.
- Table of Authorities source launch: versioned managed virtual environment,
  keyed by the runtime requirements hash.
- Standalone executables: bundle application runtime dependencies.
- DuckDB/PyArrow: importer extra, never imported on normal startup or lookup.
- `open-legal-data doctor --check-write` is a release and support check.
- A missing optional importer dependency produces one actionable command and
  does not disable public-API fallback or existing SQLite snapshots.

## Table of Authorities migration

1. Read exact local A2AJ data from OpenLegalData SQLite first; public A2AJ is
   the miss/unavailable fallback.
2. Move A2AJ snapshots and HTTP cache to the shared root.
3. Keep the deterministic engine and CLI stable.
4. Serve a single browser UI from a localhost-only Python job host:
   Automatic / Import / Review / Build / Insert PDFs, Manual, and Settings.
5. Add Table of Authorities as Beaver's sibling navigation category by
   lazy-starting that host and embedding its exact UI.
6. Make the browser UI the default standalone GUI; retain `tk-gui` only while
   parity gaps remain.
7. Package the same host and static files for a desktop executable. A native
   WebView frame is optional and must contain the same URL; it must not gain a
   separate application bridge.

## ALR Quote Verifier boundary

1. Keep ALR's repository, runtime, GUI, CLI, and release process independent.
2. Do not import ALR modules or require an ALR checkout from Beaver.
3. Audit existing ALR downloads and import only reusable provider material
   through an explicit, non-destructive OpenLegalData compatibility path.
4. Keep ALR settings, prompts, results, and derived caches in ALR's namespace.
5. Port only general algorithms into neutral packages with compatibility notes
   and parity tests.
6. Offer any future ALR adapter upstream; do not make an internal fork the
   shared dependency.

## Equivalence tests

- Run identical project/review JSON through CLI, standalone browser, and Beaver.
- Compare review mutations, CLI argv, manifests, output hashes where
  deterministic, and displayed job errors.
- Restart hosts mid-job and confirm persisted job state is readable.
- Launch with DuckDB and PyArrow absent and prove normal SQLite/API workflows
  still work.
- Launch against a corrupt/partial `*.new` file and prove the previous live
  snapshot remains available.
- Verify both Beaver and standalone render the same static asset hashes.
- Verify all Beaver tools start and pass lookup tests with no ALR checkout.

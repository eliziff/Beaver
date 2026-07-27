# Mike-Canada agent guide

Keep changes small, measured, and local-first.

## Source of truth

- `docs/mike-canada-master-plan.md` owns priorities and acceptance gates.
- `docs/README.md` indexes research and architecture notes.
- `subrepos.lock.json` pins the three independent local repositories.

## Invariants

- Account-free local mode is first-class; cloud/Supabase support remains.
- Shared databases and caches live under the `OpenLegalData` AppData contract.
- SQLite is the runtime format; bulk-import dependencies stay optional.
- ALR Quote Verifier remains independent. Port small neutral algorithms; do not
  import its private modules.
- `universal-legal-pdf-engine` owns neutral PDF structure.
- Exact evidence, versions, pinpoints, hashes, and receipts are durable state.
- URL fragments, pinpoints, and simple document mutations are deterministic
  tools, not model-generated prose.
- Model and effort choices come from provider capabilities; do not hardcode a
  reduced catalog.

## Engineering budget

- Keep a modular monolith. Add a boundary only for a true external
  provider/process or independently owned subrepo.
- Prefer native browser features, Node/Python standard libraries, and existing
  dependencies. A new runtime dependency must delete more risk or code than it
  adds and must have a named production caller.
- Keep one implementation of each workflow. Share small neutral algorithms or
  versioned SQLite/JSON/CLI contracts, not private cross-repo imports.
- Load cloud-only and heavy route-only code only when that path is used.
- Do not add one-implementation interfaces, speculative configuration, wrapper
  layers, or generalized frameworks without a second proven caller.
- Record before/after build, bundle, startup, and interaction measurements.
  Revert an optimization that is not a strict win.

## Checks

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 smoke -WithTableOfAuthorities
```

Use focused checks while iterating; full builds are release gates. Measure UI
or bundle changes before keeping them, and do not remove useful warmup merely
to improve a build number.

## Repository hygiene

- Never commit credentials, AppData, downloaded corpora, model traces, caches,
  generated PDFs, or managed runtimes.
- Preserve anonymous and cloud paths when changing shared behavior.
- Commit nested repositories first, regenerate their bundle, update
  `subrepos.lock.json`, then commit the root gitlink.
- Keep benchmark claims fail-closed: provisional, automatic, duplicated, or
  derivative labels are not human gold.

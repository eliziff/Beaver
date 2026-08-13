# Beaver agent guide

- Keep changes small, local-first, and consistent with `docs/beaver-master-plan.md`.
- Preserve both account-free local mode and cloud/Supabase support.
- Beaver has no users. Unless the user specifically requests it, replace old designs outright; do not add transition states, backward compatibility, or migration infrastructure.
- Before building a feature, canvass the repository for existing primitives and route the feature through them instead of reimplementing them.
- No half-measures in refactors. Preserve user-facing capabilities, not current module boundaries: decompose monoliths and fix root architectural problems even when multiple subsystems or consumers must change together.
- Treat corpus-scale legal ingestion and structure derivation as high-fidelity systems. Refactor them deliberately, and require corpus-scale output-fidelity checks unless the change inherently cannot affect their output.
- Reuse existing code and data before adding implementations, dependencies, or network fetches.
- Keep the modular monolith and respect boundaries in `subrepos.lock.json`.
- Long-running scripts must report progress and preserve usable partial results.
- Test behaviour and durable contracts, not incidental UI copy or implementation presence.
- Never commit credentials, AppData, downloaded corpora, caches, generated artifacts, or managed runtimes.
- Do not use metered APIs unless explicitly authorized.
- Keep experiments in `experiments/` or a package's `experiments/` directory.
  Experiments may import production; production and its tests must never import
  experiments. Keep experiment checks beside the experiment, raw output ignored,
  and durable findings in `RESULTS.md`. Promotion moves proven code and tests into
  production without a compatibility shim.

Release checks:

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 smoke -WithTableOfAuthorities
```

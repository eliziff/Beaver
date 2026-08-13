# Beaver agent guide

- Keep changes small, local-first, and consistent with `docs/beaver-master-plan.md`.
- Preserve both account-free local mode and cloud/Supabase support.
- Reuse existing code and data before adding implementations, dependencies, or network fetches.
- Keep the modular monolith and respect boundaries in `subrepos.lock.json`.
- Long-running scripts must report progress and preserve usable partial results.
- Test behaviour and durable contracts, not incidental UI copy or implementation presence.
- Never commit credentials, AppData, downloaded corpora, caches, generated artifacts, or managed runtimes.
- Do not use metered APIs unless explicitly authorized.

Release checks:

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 smoke -WithTableOfAuthorities
```

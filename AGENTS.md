# Beaver agent guide

Keep changes small, measured, and local-first.

## Source of truth

- `docs/beaver-master-plan.md` owns priorities and acceptance gates.
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
- Preserve Mike's document-version semantics: an upload or one consolidated
  assistant-edit turn creates a durable version; accept/reject decisions update
  that working version and their edit receipts, not one new version per click.
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

## UI content rule

- Use a consistent text hierarchy whose visual prominence tracks informational importance, so titles, headings, body copy, labels, metadata, and controls never compete or receive arbitrary emphasis.
- Every visible word must add information or enable an action. Delete headings,
  badges, descriptions, counts, and status copy that merely repeat adjacent
  content or state already obvious from selection, position, or control labels.
- Never restate a selected filename with prefixes such as `Selected:` when the
  filename is already visible. Do not repeat file type, capability, workflow,
  or current location in the same surface.
- Helper text is for a material consequence, tradeoff, recovery step, or
  unfamiliar legal concept. It is not a second rendering of the control label.
- When changing a surface, audit its nearby shared components for the same
  redundancy pattern instead of patching one string.
- Never put an arbitrarily growing collection in a dropdown. Versions,
  projects, chats, workflows, sources, labels, and histories use a searchable
  list or panel with bounded rendering and incremental loading.
- Async UI must have stable first-frame geometry. Keep shared layouts mounted,
  prefetch likely routes, show cached state while refreshing, and reserve the
  final dimensions of lists, viewers, controls, progress, prompts, images, and
  embedded apps.
- Loading, empty, error, and ready states replace content inside the same
  bounded shell. Never insert a banner, spinner, toolbar, iframe, or status row
  into normal flow after paint. A skeleton must match the final geometry.
- Validate route transitions and async state changes with a layout-shift
  observer and screenshot filmstrip, not only a settled-page screenshot.
- Horizontal scrolling is forbidden for the app shell, routes, panels, forms,
  lists, cards, titles, controls, and ordinary tables. Reflow, wrap, truncate,
  or change the layout instead. Inherently two-dimensional artifacts such as a
  spreadsheet or oversized source page may pan only inside their own bounded
  viewer; surrounding navigation and controls stay fixed.
- Do not stretch content merely because viewport width is available. Reading,
  chat prompts, settings, setup, forms, and linear workflows use a deliberate
  human-scale max width and compact aligned controls. Reserve full width for
  genuinely spatial work such as document pages, spreadsheets, comparison
  grids, and graph canvases.
- Interaction state must never move UI. Hover, focus, active, selected,
  loading, and completed states may change colour or fill inside preallocated
  geometry, but not font weight, border width, padding, label/icon occupancy,
  control dimensions, or neighbouring positions. Assert bounding boxes before
  and after representative clicks.

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

## Session-learned working notes (2026-07-28)

- The full A2AJ bulk corpus (4.8 GB parquet: cases by court, laws by
  jurisdiction, `laws/lookup.duckdb`) lives at
  `%LOCALAPPDATA%\ALR Quote Verifier\a2aj_corpus`. Check it (and
  `Desktop/legal-generalization-corpus`) before any network fetch of
  Canadian legal text. A2AJ mirrors consolidations, so spent amending
  acts read "[Amendments]" — amendment prose only exists on the Justice
  Laws Annual Statutes pages.
- Deterministic legal-text modules (`legalTextAnchors`, `legalTextSkeleton`,
  `legalAmendOps`, `legalDeadlines`, `legalTermDrift`, `legalDraftingLint`):
  no grammar change without a corpus/gold measurement (USLM gold, CUAD,
  structure-gold, or a real-instrument probe). Refusal beats guessing:
  scoped/ambiguous inputs get typed refusals, never best-effort applies.
- LAB harness (`Desktop/harvey-labs`): set `LAB_SANDBOX_ENGINE=docker`
  (default is podman and fails with WinError 2). `backend/.env`
  ANTHROPIC_API_KEY is a non-working stub (401) — flat-rate surfaces
  (codex CLI route, headless `claude -p`) are the sanctioned model paths.
- Windows shell traps: `grep -oP` dies on locale (use `sed -n
  's/^KEY=//p'`); vitest output may contain NULs (`| tr -d '\0'`);
  `PYTHONIOENCODING=utf-8` for cp1252 consoles; python can't open
  `/c/...` paths (use `C:/...`).
- Git: pathspec-only staging (never `git add -A`; concurrent sessions
  share this tree). Pushing as eliziff requires `env -u GITHUB_TOKEN`
  (the env PAT is AlbertaLawReview and 403s).
- npm `.CMD` shims (e.g. `claude.CMD`) re-parse argv through cmd.exe:
  multi-line or quote-bearing args silently break (empty stdout). Keep
  CLI args single-line and quote-free; ship rich payloads via stdin.
- LAB experiment design: harness A/B with the MODEL HELD CONSTANT
  (claude-code/claude-sonnet-4-6 via `claude -p`; ollama/qwen from the
  desktop PC). Codex was pilot scaffolding only — never an experiment
  cell. `cc-harness-*` results = Claude-Code-as-product side runs.

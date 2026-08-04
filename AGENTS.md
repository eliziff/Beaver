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

## Long-running scripts

- Idempotent and resumable: persist progress per unit (atomic temp-file +
  rename after each item or small batch, never only at the end). A killed run
  must leave usable partial state and reproduce the same result when restarted.
- Output as you go: print per-unit progress or heartbeats that flush. Background
  runs write to an appended log file so a kill still leaves a trail showing
  exactly how far the run got.
- Guard every loop and draw against pathological inputs (zero/NaN counts,
  sizes near the population) with typed errors and bounded iteration. A long
  silent run is a defect, not a mystery to debug after the fact.
- When running long scripts from the shell, never funnel output through
  buffering wrappers (e.g. `Select-Object -Last`); redirect to an appended log
  and tail it instead.

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
- Do not modify a README to add technical details unless the user explicitly requests it.
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
- US case law is ALSO local: a 5.5 GB CourtListener bulk sqlite at
  `%LOCALAPPDATA%\OpenLegalProducts\LegalData\providers\courtlistener\`
  (plus `journals` and `a2aj` provider DBs beside it), queried via
  `backend/src/lib/courtlistenerLocalBulk.ts` including
  volume/reporter/page citation lookup. Same rule: local before network,
  and when the network is unavoidable, exhaust a provider's BULK exports
  (e.g. CAP static volume zips at `<slug>/<vol>.zip`, cached under
  `alienness/us_reference/zips/`) before per-item API calls. Derived
  stores beat raw files: query the existing sqlite/duckdb surfaces
  (CL bulk, citator noteup.sqlite, alienness indexes, a2aj lookup.duckdb)
  instead of re-parsing the CSVs/parquet they were built from, and never
  rebuild an index that's already on disk (check its `meta` table first).
- Journal footnote pairs: `%LOCALAPPDATA%\ALR Quote Verifier\citator\
  journal_commentary.sqlite` (18,595 articles, 237,236 paired notes,
  75,018 citations; built from public_endpoint.db plaintext by
  `backend/scripts/pair_journal_footnotes.py` — interim). The canonical
  digital-native pairs live in `Desktop\Open Access Journals Database\
  oajd\journals.db` `article_final_contracts` (6,937 packages, all
  local, pages.jsonl annotations fn_label/fn_ref from
  footnote_pairing_v2; same article_id space as public_endpoint.db) —
  prefer that lane once wired. Root-level journals.db is an empty stub.
- Citation detection/resolution: call the EXISTING machinery; do not
  invent another in-place regex. The surfaces: `citationKey.ts`
  (`citationLookupKey` — the one corpus-identity normalizer — and
  `citationsInText` / `hasCitationInText`, the one in-text detector for
  citation-shaped substrings of free text, calibrated on 3,000 citator
  edges; consumed by `citatorExcerpts.ts` and `a2ajPassageSearch.ts`),
  `caselawCitator.ts` (`citationAliasKeys` same-decision alias expansion
  through resolution evidence; note-up), the corpus `citation_lookup` /
  `lookup.duckdb` indexes, `courtlistenerLocalBulk.ts`
  (US volume/reporter/page lookup) and eyecite for the US lane. Distinct
  contract, deliberately not folded in: the neutral-citation PARSERS in
  `canliiUrls.buildCanliiCaseUrl` / `legalSourceLinks.answerCaseCitations`,
  which need year/court/number capture groups and the wider court-slug
  charset the CanLII route table gates. If a task needs a citation shape
  none of these detect, expand the shared module — with tests beside the
  existing ones (`citationKey.test.ts`) — so every caller inherits it; a
  new one-off pattern in a consumer file is a defect.
- Deterministic legal-text modules (`legalTextAnchors`, `legalTextSkeleton`,
  `legalAmendOps`, `legalDeadlines`, `legalTermDrift`, `legalDraftingLint`):
  no grammar change without a corpus/gold measurement (USLM gold, CUAD,
  structure-gold, or a real-instrument probe). Refusal beats guessing:
  scoped/ambiguous inputs get typed refusals, never best-effort applies.
- LAB harness (`Desktop/harvey-labs`): set `LAB_SANDBOX_ENGINE=docker`
  (default is podman and fails with WinError 2). `backend/.env`
  ANTHROPIC_API_KEY is a non-working stub (401) — flat-rate surfaces
  (codex CLI route, headless `claude -p`) are the sanctioned model paths.
- NO OpenAI API spend, ever (rule 2026-08-04): `platform.openai.com`
  per-token billing is forbidden, including the `backend/.env`
  OPENAI_API_KEY (that key is credit-exhausted anyway). Do not launch
  arms, judges, or probes against the OpenAI API. Replication/multi-model
  work runs on flat-rate surfaces (codex CLI, `claude -p`) or the
  authorized DeepSeek API lane only.
- Windows shell traps: `grep -oP` dies on locale (use `sed -n
  's/^KEY=//p'`); vitest output may contain NULs (`| tr -d '\0'`);
  `PYTHONIOENCODING=utf-8` for cp1252 consoles; python can't open
  `/c/...` paths (use `C:/...`).
- Git pushes: use `https://eliziff@github.com/eliziff/Beaver.git` with Git Credential Manager and clear `GITHUB_TOKEN` first.
- npm `.CMD` shims (e.g. `claude.CMD`) re-parse argv through cmd.exe:
  multi-line or quote-bearing args silently break (empty stdout). Keep
  CLI args single-line and quote-free; ship rich payloads via stdin.
- LAB experiment design: canonical harness A/B claims hold the MODEL CONSTANT
  (claude-code/claude-sonnet-4-6 via `claude -p`; ollama/qwen from the
  desktop PC). Separately labelled Codex/Luna API side runs are allowed on
  visible-dev tasks when the user authorizes them, but must not be pooled with
  or presented as those controlled A/B cells. Never expose held-out tasks.
  `cc-harness-*` results = Claude-Code-as-product side runs.

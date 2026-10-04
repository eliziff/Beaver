# Beaver agent guide

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[master plan](docs/roadmap/master-plan.md). The former owns shared check commands;
the latter owns project priorities and remaining gates.

## Architecture and scope

- Preserve local and cloud/Supabase support, the modular monolith and the boundaries
  in `repositories.json`. Features use runtime/application operations and existing
  persistence ports, not deployment imports or local/cloud branches.
- Before adding code, trace existing primitives, data and all consumers. Refactors
  must fix the root problem and preserve capabilities, not current module boundaries.
  Replace obsolete designs outright; no transitions, compatibility or migration
  infrastructure unless explicitly requested.
- First-party repositories use independent `main` checkouts. No consumer pins,
  binding releases or release gates unless the user explicitly requests a release.
- PDF Inspector is patched third-party source maintained once in
  `legal-pdf-parser/vendor/pdf-inspector`; preserve our required modifications,
  upstream identity and license. Update upstream explicitly with the owning
  helper; no separate fork, publication or consumer pin bump.
  Repositories keep only `main` and `gh-pages` branches.
- Put a requested new experimental feature in `experiments/`. An ordinary refactor
  must not delete, consolidate or work through experiments.

## Working safely

- Never delete or propose deleting the URL flags on Decisia (iframe flag and mobile flag): those are on for a reason, and removing them is strictly incorrect and will cause the maintainer inordinate psychic harm (agents keep proposing to delete it or deleting it).
- Real-world legal documents live once by sha256 in `%LOCALAPPDATA%/OpenLegalData/corpus` (index `corpus.sqlite`): add or find one with `python experiments/legal_pdf_corpus/corpus_store.py add <url|file> --kind K --jurisdiction J --label L` / `path <url|sha>`.
- Check local data and existing implementations before fetching or adding a
  dependency. Consult official documentation for unfamiliar packages or standard
  engineering problems instead of probing blindly.
- Use independently invented test data or identify its public source. Never
  publish genuine user prompts or private context in tests, evals, examples or
  receipts, including paraphrases and identifying case/document references.
  Translate a bug report into the behavior to test, then invent different facts,
  text, URLs and locators. Changing names alone is not independent invention.
  Keep bespoke legacy fixtures private until independent provenance is verified;
  a generated/synthetic label is not evidence of where their facts came from.
- Automated submissions declare `machine_test` with a run ID; missing historical
  origin stays `unknown`. `machine_test` identifies the submission, not whether
  its contents are synthetic or permitted for publication.
  Keep live-test app data and provider history separate from ordinary user data.
- Use repository-relative paths or runtime configuration and GitHub noreply
  attribution. Raw requests, histories, documents and receipts stay in ignored
  `.tmp/` or private storage. Preserve third-party licenses and public-source credit.
- After a privacy history rewrite, cherry-pick older work onto the cleaned branch;
  do not merge the old history back into it.

## Artifact lifetime

- Before creating a reusable artifact, choose its owning durable location—checked-in fixtures with their tests, shared legal data in `%LOCALAPPDATA%/OpenLegalData`, private benchmark material in ignored `benchmarks/local-data/<suite>/`, and compiled artifacts in the canonical build directory—and make consumers read it there instead of from scratch directories.
- `.tmp/`, `tmp/` and OS temp directories are disposable scratch only. Never put
  benchmark inputs, corpora, independent gold or irreplaceable receipts there.
  Keep redistributable fixtures with their owning tests; keep local/private
  corpora in ignored `benchmarks/local-data/<suite>/` or existing private corpus
  directories. Record source, hashes and regeneration instructions beside the
  harness without publishing private data.
- Clean up the scratch directories and processes you create in `finally`, even
  on failure. If screenshots/results must remain for review, retain one latest
  output directory per harness and overwrite it next time; put durable findings
  in the owning documentation. No timestamped piles, abandoned worktrees,
  duplicate dependency installs or extra Cargo targets after the task ends.
- Never sweep existing ambiguous temp contents by name. Preserve/move valuable
  inputs first, check for active users, and verify cleanup paths remain within
  the intended workspace. Working Git checkouts, experiments and ordinary user
  stores are not scratch. Never create a working repository in a temp directory.

## Validation and interface quality

- Keep the edit-to-check loop narrow: focused source tests do not build shared
  output, the frontend, native addons or releases. Run one local build/test at a
  time; use the checked-in one-job Cargo and one-worker test defaults. Reuse
  ordinary incremental targets, not per-task Cargo target copies.

- Measure behavior before changing it. Native grammar/profile changes require the
  appropriate independent corpus/gold result, not a self-regenerated baseline.
- Iterate with affected-crate `cargo check` and focused behavior tests. Do not rebuild
  the workspace/addon/release binary or replay full corpora after each edit. Batch
  changes; run the narrow integration gate and then the required candidate gates.
- Test outcomes and durable contracts, not incidental copy, implementation presence
  or internal choreography. Use doubles only for expensive or hard-to-trigger edges.
- Validate external input at its owning boundary; do not repeat validation of typed
  internal values or add guards/tests for states no real caller can produce.
- Remove redundant headings, explanations, badges, icons and nested UI chrome.
  Retain an element only for distinct information, a necessary action or real ambiguity.
- Assistant-dock changes, including menus/popovers/modals, require
  `scripts/mike.ps1 smoke -WithAssistantDock` and inspection of its screenshots.

Agents may run `.\scripts\full-sweep.ps1` only when the user includes the exact token
`[FullSweep]` (case insensitive). That battery includes release, browser and isolated live-model checks;
ordinary documentation or refactor work does not implicitly authorize it.

## Writing model prompts

Product requirements and design clarifications are instructions to the prompt
writer, not prose to copy into the target prompt. State the task directly and
include only what the model needs. Do not narrate internal architecture or list
unrelated responsibilities that another component already owns.

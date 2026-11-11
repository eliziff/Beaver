
## Ponytail it
If asked to do a task involving PDF extraction, use our own legal pdf parser (which is built on pdf-inspector). It is much faster and better than stuff like pymupdf, tesseract, etc.
Generally, we have a lot of utilities and code to cover a wide variety of situations -- check the existing code
before handrolling new stuff. Common sins: handrolling/creating python census scripts instead of using 
existing parsing or creating a small rust utility, handrolling new page or paragraph detection.

## No legacy shims: make one small abstraction
If asked to make the code smaller, cleaner, better, lazy looks for "dead code" are usually not
what the maintainer is after. Look for needless abstractions or conversion shims.
Similarly, don't write conversion shims between a producer/consumer combo that we create: instead, figure out which is the cleaner, better abstraction/what the project is following,
and make whichever consumer it is follow that (or vice versa with a producer); creating a translation layer is silly
because this is a ZERO user project! Nobody uses this but us! There is almost always 0 value in
migration scripts or legacy coverage etc for that reason -- we control the pdf parser, we control authorities,
we control alr-verifier, we control beaver, legal structure parser, common law cite, etc -- we want simple, easy to maintain code with no duplicates
of behaviour that should belong to all of them, and no translation layers between them or within them.
Since we control both sides of the equation, we should just make things simple and direct, with fine-grained
APIs/decoupled producers/modules so that whichever thing can just take what it needs.

## Zero users
These apps have effectively 0 users. We do not need to be concerned about migrations or big refactors.
This codebase is yours to shape and mold: how it's built is your call, and you'll keep building on it.

## Rust layer gets the heavy duty stuff, not typescript
If you notice that typescript is doing heavy processing somewhere, that's usually a mistake
and it should be done in rust instead. Flag these things for the user to see if it shoudl be fixed.
Similarly, python is generally not going to contain product logic. It's fine for one-off or immediate scripts or 
whatever you LLMs like to do, but the end product is not going to contain it.


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
- Bulk data stores live once by sha256 in `%LOCALAPPDATA%/OpenLegalData/corpus` (index `corpus.sqlite`): add or find one with the corpus store in the gold store/private benchmarks checkout (`benchmarks/local-data`).
- Check local data and existing implementations before fetching or adding a
  dependency. Consult official documentation for unfamiliar packages or standard
  engineering problems instead of probing blindly.
- Automated submissions declare `machine_test` with a run ID; missing historical
  origin stays `unknown`. `machine_test` identifies the submission.
  Keep live-test app data and provider history separate from ordinary user data.
- Agents are not allowed to write license files unless explicitly requested to do
  so; and even then it should only be for true third party software, not
  cross-attribution of the maintainer's own repositories.
- Use repository-relative paths or runtime configuration and GitHub noreply
  attribution. Raw requests, histories, documents and receipts stay in ignored
  `.tmp/` or private storage. Preserve third-party licenses and public-source credit.


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

## Validation and interface quality

- Keep the edit-to-check loop narrow: focused source tests do not build shared
  output, the frontend, native addons or releases. Run one local build/test at a
  time; use the checked-in one-job Cargo and one-worker test defaults. Reuse
  ordinary incremental targets, not per-task Cargo target copies.

- Build root-workspace Rust only through `node scripts/cargo.mjs <args>` (`npm run native:build` uses it); run a
  sub-workspace's cargo from its own folder. A plain `cargo` at the root rebuilds every shared crate (CONTRIBUTING.md).
- Iterate with affected-crate `cargo check` and focused behavior tests. Do not rebuild
  the workspace/addon/release binary or replay full corpora after each edit. Batch
  changes; run the narrow integration gate and then the required candidate gates.
- Test outcomes and durable contracts, not incidental copy, implementation presence
  or internal choreography.
- Validate external input at its owning boundary; do not repeat validation of typed
  internal values or add guards/tests for states no real caller can produce.
- Remove redundant headings, explanations, badges, icons and nested UI chrome. (and screenshot check this)
- No UI "taglines" like "Your files, right where you left them." That's marketing speak; it is very annoying to read. 
- Similarly, talk like a normal person, and write feature descriptions with AI slop speak (mannered prose is awful).

Agents may run `.\scripts\full-sweep.ps1` only when the user includes the exact token
`[FullSweep]` (case insensitive). That battery includes release, browser and isolated live-model checks;
ordinary documentation or refactor work does not implicitly authorize it.

## Writing model prompts

Product requirements and design clarifications are instructions to the prompt
writer, not prose to copy into the target prompt. State the task directly and
include only what the model needs. Do not narrate internal architecture or list
unrelated responsibilities that another component already owns. 
When writing a new prompt for another model, or editing one, present it to the user.

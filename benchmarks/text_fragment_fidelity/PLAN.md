# Text fragment fidelity

Prove that Beaver-built pinpoint links land on the intended passage of live
publisher pages - at corpus scale, without manual clicking.

## Loop

1. **Seed**: a passage with its evidence coordinates (provider URL class,
   anchor, block text, quotes). Seeds start curated from real citations;
   random sampling over local corpora scales the same shape later.
2. **Build**: produce the URL through production
   `backend/src/lib/legalSourceLinks.ts`, never a reimplementation.
3. **Verify**: open in real Chrome (`scripts/text-fragment-gate.mjs`
   machinery), record scroll landing, screenshot, and - where an anchor is
   known - whether the landing sits past the first body anchor.
4. **Mine**: align seed text against rendered block text to discover new
   provider projection rows (whitespace padding, punctuation restyling,
   front-matter duplication). Proven rows move into the builder as single
   forms; unproven ones ship as sibling variants.

## Tiers

- `smoke`: curated seeds across SCC Decisia, King's Printer, CanLII.
  Minutes; validates machinery and baselines verdict shapes.
- `dev`/`full`: sampled corpus passages per provider class (future).

Politeness: sequential requests, seconds between page loads, no parallel
hammering of publisher sites.

## Acceptance metrics

- Correct-landing rate per provider class (scroll position shows the seeded
  passage; screenshot confirms).
- Headnote/front-matter lock-on rate: zero tolerance for paragraph-scoped
  seeds whose landing precedes the first body anchor.
- Silent-failure rate: directives present in the built URL that match
  nothing on the page.

Summaries are committed under `results/`; raw screenshots stay in the
operator-supplied output directory.

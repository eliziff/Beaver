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

## Link strategies

Evidence for product choices about which link a row carries. Each link
has a role, and the two roles are judged against different targets:

- **Citation link**: clicked to reach the cited pinpoint (paragraph,
  section, printed page). A supra/ibid row's target is the origin note's
  source at the referring note's pinpoint.
- **Quote link**: highlights the quoted words.

Seeds: `results/link-strategies.seeds.jsonl`. These are real rows from the
categories in which the Python ALR app's links and the new pipeline's links
differ. Each row lists the two production URLs verbatim and the alternatives
for its source type. Alternatives are built with production `sourceUrl()` /
`buildCanliiLawUrlFromCitation()` and reuse a directive one of the two apps
emitted. No candidate contradicts a decision already in the link code. Every
Decisia URL carries `iframe=true&site_preference=mobile`, anchors appear only
where `legalSourceLocatorAnchor` emits them, and production outputs that break
such a rule are tested but marked `conflict`.

Tiers:

1. `--tier cache` (`cache-tier.mjs`) serves saved CanLII pages from the
   Pinpointer corpus (`%LOCALAPPDATA%/OpenLegalData/pinpointer-corpus`) and
   any `--canlii-cache` store under their original paths, blocks all other
   traffic, and records:
   - whether the anchor exists and is in view;
   - whether `::target-text` painted, measured by screenshot pixels;
   - the landing paragraph/section, and whether the landing is front matter;
   - whether scrolling still works after the landing.
   This tests the directive against the page bytes, not the site's own
   behaviour.
2. Live, in the user's own browser and only for site behaviour the cache
   cannot show: Decisia rendering, PDF viewer `#page`/directives, journal
   hosts, CanLII redirects and slugs. Pace it like a human; CanLII sees
   only a handful of pages per run.

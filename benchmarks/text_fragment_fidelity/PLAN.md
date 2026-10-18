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

## Plan: most real hits per link (2026-10-15)

Goal: every pinpointed or quoted link a product emits (ALR workbook,
Authorities, Beaver chips) paints the intended words and lands on the intended
passage, on whichever provider page gets that most reliably. The planner
(`legal-structure` `text_fragment.rs`, built over many commits: rarest-word
replay, Chromium context rules, short-paragraph targets, one-pass index) stays.
This plan aims it at the text the reader actually opens.

### What we know

| Route | Evidence | Result |
|---|---|---|
| A2AJ text -> publisher pages (Decisia, King's Printer, PDFs), v26 router | `experiments/text-fragment-fidelity`, 2,370 seeds | 2,369 strict exact + 1 PDF geometry limit; in production |
| CanLII page text -> CanLII page (perfect oracle, not a test of real links) | Pinpointer `results/paint-gate-full-v3.jsonl`, 3,582 selections | 3,496 exact; 86 planned no directive even with the page's own text: planner gaps to fix |
| A2AJ text -> CanLII page (ALR's links) | cache tier 2026-10-04 (94 candidates); 25-link check 2026-10-15 (unverified method) | mixed: wrong paragraph (`#par85` lands par86), title lock-on, painted nothing |

Planning from flattened A2AJ text is proven on publisher pages, so the causes
of the CanLII-route misses are unknown until each miss is read; the gate below
establishes them. The 2026-10-14 change
(`3226055a41`) made `citedPassageLink` plan every member of the range on every
call: 67 calls at 37-50 ms per workbook, the 4x slower workbook step. It also
bypassed the plan cache from `113a8d81d2`.

### Corpus

1. CanLII pages: Pinpointer (497 directories), ALR's `cache/canlii_html`
   (512), plus every page the 16 manuscripts' workbooks link to (156 missing,
   captured with ALR's undetected-Chrome fetcher, paced 8-15 s), then a
   stratified extension from `jobs/canlii-diverse-*.json` across courts,
   tribunals, statutes and regulations. Cache only; no fragments fetched live.
2. Seeds, each with its intended target (paragraph/section id or quoted words)
   and link role (citation vs quote):
   - every citation and quote link in the 16 manuscripts' workbooks;
   - `link-strategies.seeds.jsonl`;
   - a stratified sample of paragraphs, sections and quotations from cached
     pages that also exist in the local A2AJ store.
   Freeze the seed manifest with a hash before any builder change.

### Gate

Use the existing machinery, not a new harness: `cache-tier.mjs` route
interception plus the experiment's replay gate (paint by screenshot pixels,
landing block, front-matter lock-on, scroll after the jump). Calibrate replay
against headed Chrome on a small sample. Verdicts: strict exact (intended
words painted, landing on the target), anchor-only (target reached, nothing
painted), wrong landing, silent failure (directive matches nothing).

### Arms (baseline + at most three)

- Baseline: production today (planner over A2AJ text, range plan per call).
- A. Planner rules for the miss classes the gate actually finds (Mining).
- B. Route per link with the v26 no-oracle router facts: CanLII anchor+fragment,
  publisher page, or A2AJ Law Web. Python ALR's CanLII-only links are the
  parity reference. The user authorized maximizing hits on any provider
  ("whether it be on canlii or another provider"), so a route change is
  reported per row in the workbook diff.
- C. A + B together.

The 2026-10-07 opening/closing-words directive is measured as a reference
row in the gate only. It is not a candidate to restore.

### Mining

Align every missed seed's A2AJ block text with the rendered CanLII block,
classify the miss (projection difference, earlier duplicate, end never found,
anchor/fragment conflict, structure mismatch), and turn each proven class into
one general planner or projection rule in Rust. No per-page or per-document
exceptions. Promotion follows the experiment's criteria: demonstrated on
captured pages, no regression on matched seeds, planner-equivalence hashes
identical for pure speed changes.

### Speed

The workbook reuses the plans its quote check already made (the `113a8d81d2`
cache) and caches range plans per (document, range). Profile
`build_selected_fragment_plan` and fix its per-call cost behind the planner
equivalence tier (`planner-equivalence.mts`, identical hashes). Target: Sun's
workbook step back near 0.7 s, with no lost hits.

### Acceptance

Strict-exact rate per provider class and link role, on the frozen seeds,
reported as before and after for every arm. Zero front-matter lock-on and zero
wrong-paragraph landings for paragraph-scoped seeds. Silent failures counted
separately. Report the workbook diff on the 16 manuscripts row by row.

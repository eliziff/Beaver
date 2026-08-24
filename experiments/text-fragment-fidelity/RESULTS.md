# RESULTS — text-fragment fidelity at corpus scale

Date: 2026-08-22. Corpus: **1000-decision target, 1739 seeds** over 924
usable decisions (see `results/manifest.jsonl`), stratified across all 27
A2AJ case datasets and **19 publisher hosts**. Gate: black-box Chrome load →
lavender `::target-text` pixel detection on viewport screenshot. Idempotent
(resume by label); raw outputs under `results/`.

## Headline

| verdict | n |
|---|---|
| matched | **1624** |
| no-highlight | 115 |

**93.4% of seeds paint a highlight** built purely from flattened A2AJ text.
Per-dataset match rates: SST 100%, FC/OIC/CIRB/CMAC ≥98%, SCC 96.4%,
BCCA 95.7%, BCSC 96.8%; laggards CITT 86.8%, NSPC 89.6%, SCT 90.2%,
CART/CHRT 91.4%, and **CT 62.1%**.

## Failure taxonomy (115)

1. **dead-page — 50.** The URL serves no decision text at all: bccourts
   "File Not Found" stubs, Decisia "Validation" pages, tribunal error pages
   (clusters: NSPC 7, SCT 6, ONCA 5, TATC 5, NSSC 4, NSSM 4, NSFC 3, TCC 3).
   Removed/restricted/re-indexed items: the corpus URL outlived the content.
   Rechecked with marker-free mid-quote needles (`recheck-drift.mjs`); these
   have neither the quote nor anything like it.
2. **pdf-card — 19.** Publisher page is a metadata stub whose only content
   link is a PDF download (concentrated in CT, hence its 62% rate). There is
   no HTML text to fragment.
3. **projection-gap — 46** (32 gap + 9 restyled + 5 styling-drift). Quote
   text IS on the page; the fragment spelling missed. Proven sub-causes:
   - **detached punctuation** — a space inserted before/around punctuation
     by the publisher template: bccourts renders `</i> :` ("Charter of
     Rights and Freedoms : s. 1" for source "Freedoms: s. 1"); CITT renders
     "60. (1)" and "8 ." for source "60.(1)". Marker-attached needles made
     these look like drift in the first pass.
   - **cross-block merges (25)** — A2AJ merges numbered lead-ins and
     list/quote continuations into one flattened block; the directive spans
     the publisher's `</p><p>` seam where separator runs do not collapse
     (markup-proven on BCCA 79: `[63] …ground that:</p><p>The Chambers…`;
     also BCCA 480's `[14] Charter…:</p><p>s. 1 …`).
   - **orphan-guarded pinpoints (3)** — `s.<NBSP>11(d)`, `para.<NBSP>33`
     where the directive carries an ASCII space; covered by the parked
     graded citation-cluster patch.
   - **curly quotes (1)** — `“[t]he` for source `"[t]he`.
   - **unexplained (14)** — no signature fired; DOM-level inspection during
     promotion work (candidates: table-cell merges, nested inline seams).

   Note: `page-drift` as first classified (55) decomposed into 50 dead-page
   + 5 styling-difference; zero true content mismatches survived recheck.

## What this proves about the method

- Building usable pinpoint links from flattened A2AJ text alone works for
  ~93% of real decisions across courts and tribunals without any provider
  branching; failures cluster into three named classes with evidence, not
  guesswork.
- Pixel-paint detection is the only reliable match signal (Chrome does not
  expose `::target-text` via selection APIs).
- Anchor fallback still lands users on the right paragraph when fragments
  miss; the residual user-facing defect is missing highlight, not wrong
  destination.

## Next steps (promotion path)

1. Prototype experiment-local builder patch. Four blind strategies, each a
   bounded sibling-variant family (unmatched variants are ignored by the
   browser):
   - graded NBSP variants (existing patch) for `s.<NBSP>11(d)`,
     `para.<NBSP>33`, link-end icon runs;
   - punctuation-detach variants for `</i> :` and `60. (1)` classes:
     insert a space before trailing colons and after abbreviation periods
     at word boundaries;
   - curly/straight quote fold;
   - seam-aware range boundaries for the sentence-join class: when the
     quote carries a `[:.]\s+[A-Z]` seam, choose the range head to end
     BEFORE the seam and the tail to start AFTER it, so start and end
     matches each live inside one publisher paragraph while the sweep still
     covers the whole quote.
2. Validate each strategy offline against `results/pagecache/` pairs and
   re-run the gate on the 46 actionable seeds plus a regression sample of
   previously-matched hosts; require zero regressions.
3. Only then promote to production with unit tests over fixtures mirroring
   the captured markup.

## Addendum 2026-08-23 — headed verification and harness

**Headed Chrome on `decisions.ct-tc.gc.ca` (real Chrome, 12s settle, screenshots in `results/ct-headed-*.png`):**

* `item/464120` (2005 Comp Trib 32, "Barcode-Symbol") — **pdf-card confirmed**: `?iframe=true&site_preference=mobile` renders 606 chars, desktop renders 693 chars, 0 `par` anchors in both, only links are `…/464120/1/document.do`. The reasons exist only as PDF. This is not a `site_preference`/`iframe` bug — stripping params does not recover body text. Correct end-product link for such legacy items is the PDF (`/document.do`) with a `page=` anchor, parallel to the existing CanLII PDF path in `sourceUrl`.
* `item/521808` (2026 Comp Trib 19) — **inline path confirmed**: same beaver params render 28,146 chars with 64 `par` anchors and the decision body ("IN THE MATTER OF…") visible below the metadata table. Modern CT decisions carry full HTML text under the load-bearing `iframe=true&site_preference=mobile` rendering; per-host param stripping is not warranted for CT. Any future exception must be headed-proven per host before scoping.

**Harness:** `candidate-builder.test.mts` was broken after the Rust document-structure migration (`createSourceDoc` removed from `backend/src/lib/sourceDoc.ts`). Restored experiment-local `createTextSourceDoc` as a minimal `SourceDoc` shape with `sourceDocTokens` attached for the legacy `block.tokens` accessors. All 8 strategies now pass plus new T9 (markdown `*…*` → stripped sibling, e.g. BC Laws `*acknowledgement*`).

**Production TODO — CT pdf-card re-route:** The blind fix in `builder-candidate.ts:758` rewrites every `decisions.ct-tc.gc.ca/.../item/<id>/index.do` to `.../<id>/1/document.do` so the A2AJ quote paints in the PDF layer with no oracle. When this is promoted, move the re-route into production — either in `backend/src/lib/legalSources/a2aj.ts` (provider compiles the PDF rendition for those 13 pdf-card IDs) or in `documentProjectionService`/`structureNative` so the canonical `SourceDoc` for those items is the PDF, not the stub. Keep `gate-replay.mjs:30` `isPdfUrl` (`/document.do` on `decisions.ct-tc.gc.ca`) in sync. This closes the entire CT pdf-card class with zero oracle and preserves the LOAD-BEARING `iframe`/`site_preference` path for modern CT HTML.

## Corrected corpus harness — 2026-08-23

The earlier full-document claim was invalid. Seed labels include a locator
(`_p85`, `_sec1`, and similar), but the harness included that locator in its
doctext lookup key. Most seeds therefore fell back silently to `blockText`.
All builders and gates now share `seed-document-key.mjs`, fail closed when a
full document is absent, and report the actual full/fallback counts. The
corrected corpus is **2,371/2,371 full documents, zero block fallbacks** over
1,217 cached publisher pages; `cache-audit.mjs` reports zero missing or invalid
cache entries.

The current fast loop is:

- production URL materialization: about **10 seconds** for all 2,371 seeds;
- warm immutable-page screen: about **1.3 seconds** for all 2,371 seeds;
- PDFium location proof: about **2.4 seconds** for all 196 production PDF
  seeds after caching normalized page text once per PDF.

The previous PDF screenshot gate accepted any purple paint from the first
directive. The replacement parses every directive, rejects duplicate or
extraneous matches, proves all requested quotes, and distinguishes exact from
contained safe-core paint. Chrome screenshots remain mandatory for final PDF
acceptance because Chrome's PDF fragment finder and PDFium text extraction can
order bilingual columns differently.

Removing the false `same_line` uniqueness constraint restored **175/196** PDF
seeds to exact or safe-core structural matches. A one-directive line-core
fallback, selected only from the intended full-document occurrence, provides a
Chrome-painted fallback for the remaining observed failures; the difficult
five-sample set was directly replayed after reducing two-sided context to the
shortest unique one-sided context. This is promising evidence, not final
acceptance: the combined no-oracle selection rule and all-seed Chrome paint
location run still have to pass before the 100% mandate is met.

## Production candidate and final headed gate - 2026-08-24

The production candidate is the exact-only, full-document planner now exposed
by `legal-structure` through the Node adapter. It builds from the full flattened
A2AJ document without inspecting the live page, returns explicit source-word
intervals and completeness metadata, permits multiple nearby exact directives,
and uses only a narrowly proven publisher capability for BC Laws annotation
seams. Production chooses an HTML or verified-PDF rendition by source coverage;
it does not blindly extend old directive families or silently claim an omitted
substantive word.

The final gate used real headed Chrome against cached complete publisher pages.
For every directive it checked isolated and combined navigation, initial
viewport landing, source-identity resolution, exact paint geometry, and absence
of stray paint. PDF acceptance additionally required PDFium source geometry and
a control-render delta. All **2,370 gettable seeds** produced terminal evidence;
the only excluded seed is the manually confirmed official 404
`FCA_2026_FC_103_p20_short-exact` (item 521765). The cache contains all 1,216
gettable pages; no gettable page is missing or an error-page placeholder.

| class | exact | total | rate |
|---|---:|---:|---:|
| HTML | 1,886 | 2,149 | 87.8% |
| PDF | 73 | 221 | 33.0% |
| **All gettable seeds** | **1,959** | **2,370** | **82.7%** |

This is the broadest and most consistently verified candidate tested, but it is
**not 100%**. The 411 non-exact results are:

- 217 initial-viewport misses and 24 initial-paint/source-range misses on HTML;
- 6 cached-rendering/projection mismatches (the raw verifier name
  `quote-not-rendered` does not mean the A2AJ quote is absent);
- 3 other HTML paint-geometry failures (two incomplete range covers and one
  extraneous paint);
- 143 PDF browser failures: 60 combined directives with no paint, 36
  extraneous directive matches, 16 directives not located, 13 wrong-page
  landings, 10 natural-landing geometry mismatches, 4 ICU replay limitations,
  3 other no-paint results, and 1 unstable control page; and
- 18 source-coverage nonclaims: 4 builder-incomplete plans and 14 additional
  omissions rejected by the verifier. Some rejected omissions are substantive,
  so completeness metadata must remain authoritative; these are not successes
  merely because the remaining words can paint.

The important residual risk is therefore explicit: HTML reliability is good but
still vulnerable to duplicate/landing behavior, while blind PDF construction is
not broadly reliable without pagination and viewer behavior. The verifier's
RGB control delta also assumes stable aligned PDF renders, and its OOPIF geometry
currently assumes Chrome's PDF surface remains bottom/right aligned. These are
documented limitations, not waived requirements for a future 100% claim.

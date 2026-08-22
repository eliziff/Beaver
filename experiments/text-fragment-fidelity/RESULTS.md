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

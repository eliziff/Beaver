# PDF parser model tiers

A plan for the two model layers of the parser described in [pdf-structure-gold.md](pdf-structure-gold.md):
a fast model inside Rust for what the witnesses leave open, and a quality model for the hardest
pages. The goal is the most structure recovered per document at two price points: a tier that runs
on the laptop CPU in milliseconds per page, and a tier that may call a hosted model. How much each
tier does is decided by measuring against the v4 gold on the family split, never by prescription.

Constraints this plan inherits: production runs on the laptop CPU (the 3080 Ti desktop is for
training only); structure logic stays in legal-structure and legal-pdf-parser, with no TypeScript
or Python re-implementations; simple and stable code; no tuning to particular documents.

## What the gold gives as targets

One `legal-structure-gold.v4` file per source, with the authoring extraction kept beside it under
`parsed/` (per-line and per-word boxes, typography, the engine's witnesses) and the page images.

| Target | Granularity | Where in the gold |
|---|---|---|
| Region (12 classes) | line | `typed[].region` |
| Unit start | line | `typed[].start` |
| Printed markers | line | `typed[].markers` (spans) |
| Note references | line | `typed[].references` (spans, label) |
| Reading order | line | order of `typed[]` |
| Relation to previous unit | unit | derived from `units[].parent`: child, sibling, up k |
| Parent | unit | `units[].parent` |
| Document start and end | unit | `units[].starts_document`, `ends_document` |
| Reference to note pairing | reference | `notes[]` |
| Corrected text | line | `lines[].corrected`, `text_edits` |

A training-row exporter (Python, a join only, no parser logic) writes one row per extraction line:
gold targets plus the features below, keyed by the authoring binary recorded in the receipt. It
lives in `experiments/legal-structure-gold/` and reads the gold, the `parsed/` cache and the witness
dump.

## Tier 0: Rust witnesses (exists)

The current inference: numbering succession, typography, bookmarks, page labels, geometry and note
evidence combined where they agree. It must already be right on clean, well-numbered documents.
Its decisions and its intermediate evidence are features for tier 1, and its replay path
(`score_all.py --tag` then `--replay`) is how a change is measured in seconds.

## Tier 1: the fast model

A sequence tagger that reads a document's pieces in order (a piece is a line cut at the
parser's block boundaries; most lines are one piece) in fixed windows with context on each side,
and labels each piece. Each unit's parent is pointed at: a pointer head scores the unit starts
before it in reach, as HRDoc and Detect-Order-Construct build a document's tree. Relations to the
previous unit, resolved one after another on the ancestor stack, were tried first and cascade:
the gold's own relations decoded that way give parents 0.758, where the gold's own pointers give
1.0 (`selfcheck labels`).

**Inputs per line** (all computed in Rust today or trivially added):

- geometry: x0, x1, y0, y1 normalised to the page; gap above and below in line heights; indent
  relative to the page's body left edge; line width fraction; column index where columns exist;
- typography (native pages): font size over the page's median size; bold, italic, small caps,
  all-caps fraction; font change at the line start;
- text shape: length; leading marker grammar hits (paragraph, section, subsection, list letter,
  bullet, note number) as the Rust grammars report them; digit and punctuation fractions; a byte
  embedding of the first 32 and last 8 bytes;
- tier 0 outputs: the candidate numbering chain the line sits in, note-pairing evidence,
  heading candidacy, furniture and folio verdicts, OCR text quality and the recognised region
  type for scanned pages;
- position: page index over page count; line index over lines on the page.

**Heads:** region (12), unit start (continues, opens, resumes an earlier unit), document start
(2), carries a note reference (2), and the parent pointer. Markers and reference spans stay with
the grammars; the model only says whether the piece has them.

**Architecture candidates**, trained and compared on the same rows:

1. gradient-boosted trees over the features with lag features from the two lines on each side:
   the cheapest baseline, pure-Rust inference, no sequence model;
2. a two-layer bidirectional GRU, hidden size 128, over the page's lines with the context lines:
   about 0.5M parameters;
3. a four-layer transformer encoder, width 128, relative positions, over the same sequence:
   about 1.5M parameters.

Pick the smallest that reaches the best one's dev score within noise. Budget: under 5 ms per page
on the laptop CPU at int8, memory flat on long documents (pages stream through; the context
window is fixed). Export to ONNX; run with `tract` or `ort` in Rust behind one trait so the
runtime can be swapped. The model is loaded once per process and shared.

**Training:** on the desktop GPU (`ssh oajd-desktop`, venv `beaver-train`), from the train split of
the family partition; cross-entropy per head with class weights for the rare regions; early
stopping on the development split; one evaluation on the test split at the end, never during
development. Train separately on native and OCR rows first, then one model with a page-source
flag, and keep whichever scores better on dev.

**Integration in Rust:** tier 1's labels enter the same inference as witnesses. Three arms are
measured on the development split, per layer of the scorer, with speed per page:

- A: tier 0 alone (today);
- B: tier 0 with tier 1 deciding where the witnesses are silent or disagree;
- C: tier 1 deciding everything, tier 0 only supplying features.

The arm that wins per layer sets the share. A layer where B and C tie goes to B, the simpler
runtime.

## Tier 2: the quality model

A vision model call over a page, or over a window of pages for the hierarchy, using the gold
prompts themselves (lines pass for regions and starts; hierarchy pass for parents and document
starts). The prompts were measured on gpt-6.1-sol low; Luna max is to be probed on the hierarchy
pass before it is used anywhere (see the model probes in
`experiments/legal-structure-gold/PLAN.md`).

**Routing:** tier 2 is called only for pages where tier 1 is unsure: low confidence on region or
start, disagreement with tier 0, poor OCR text quality, many unanchored lines, or a hierarchy
whose relations do not resolve. The routing thresholds are chosen on the development split against
a cost budget per document, and a document never fails when the call fails: tier 1's answer
stands.

**Caching:** answers are cached by page image hash and prompt hash, as the gold runner does, so a
document is paid for once.

**Circularity:** a tier built on the gold's own author model, scored against that gold, flatters
itself. The tier 2 measurement uses a held-out slice checked by a second model or by eye, and
reports that number beside the gold score.

## Layout and OCR models for scans

The training stacks live in the journals database checkout (`Open Access Journals Database/
Text-Fidelity-Project/tools/training/kraken` and `.../tools/training/ppdoc`), with their split
builders; the gold feeds them through the training-row exporter, not through new trainers.

- **Layout (ppdoc):** fine-tune the layout model on region boxes from the gold: each unit's
  lines on one page unioned into a box with the region as its label. Its region per line is a
  tier 1 feature for scanned pages, where typography is absent. Measured by the scorer's roles
  layer on OCR documents, not by box IoU alone.
- **OCR recognition (kraken):** fine-tune on the gold's corrected OCR lines, each line cropped from
  the page image by its extraction box, plus unlimited synthetic lines from native pages rendered
  and degraded. Measured by the scorer's text layer on OCR documents.
- **OCR segmentation:** the gold does not correct line segmentation (a line the engine split or
  merged stays so), so segmentation training data comes from native pages rendered with their
  exact line boxes. The gold's split and merge counts (a source line owned by two typed lines, a
  typed line spanning two source lines) are a diagnostic for choosing engine fixes, not training
  data.

## Measurement

- The family split decides train, development and test; related documents never straddle it.
- Every arm is scored on every layer of `evaluate.py` with `score_all.py`, reported as score,
  tokens where a hosted model is involved, and wall clock per page on the laptop.
- Tier 0 changes are measured by replay; tier 1 by replay with the model's labels injected; tier 2
  by a real run on the routed pages only.
- No document-specific rules. A gain that appears only on one family is not a gain.

## Order of work

1. Author the cohort gold; copy the family split and exposure audit back from E: and wire the v4
   freeze.
2. Done 2026-10-18: the model's typed order is the gold's reading order in the scorer, and the
   receipts count recognition misses and engine split and merged lines.
3. Write the training-row exporter and the witness features it needs; run tier 0 on the
   development split as arm A.
4. Train the three tier 1 candidates; pick one; export; integrate behind the trait; measure arms
   B and C.
5. Probe Luna on the hierarchy pass; set tier 2 routing on the development split; measure.
6. Layout and OCR fine-tunes for the scanned families, in that order of expected gain.
7. One test-split run per tier, reported once.

## Open questions

- The "12 (1)" convention: one unit with a two-part marker. The parser must emit the same before
  statutes score meaningfully; untested so far because no probe document had such a line.
- Whether tier 1 should also predict note pairing, or whether the TFP pairer with tier 1's region
  labels is enough; measure the pairer first.
- Luna max on the hierarchy pass.

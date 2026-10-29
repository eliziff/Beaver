# PDF parser and its gold

The parser turns any legal PDF, digital or scanned, into reliable text and structure for the
apps: quote checking and pinpoints in ALR, Authorities and Beaver (including arbitrary PDFs added
as ALR sources), text-fragment links, and reading. Project priorities stay in the
[master plan](master-plan.md).

## What it gives the apps

- **Text:** the printed text of every page, with OCR for scans, turning sideways or upside-down
  pages upright first.
- **Regions:** what each line is: running text, heading, list item, block quote, footnote or
  endnote, table, contents entry, caption, headnote, side note, running header or footer, page
  number.
- **Units:** paragraphs, headings, list items, notes and table rows, including those that
  continue across a page break; separate documents within one PDF, such as exhibits.
- **Locators:** printed page numbers, paragraph numbers and section numbers, as printed.
- **Footnotes:** every note reference paired with its note. The original pairer (TFP, ported as
  legal-pdf-pairing) was good: improve it with before/after proof on the journal footnote gold,
  never replace it wholesale.
- **Hierarchy:** what each unit falls under, so sections and subsections have extents.

The apps' features and APIs stay as they are. Changes inside the parser never change what a
consumer gets unless that is the improvement being made.

## How it is built

Three layers, one after another:

1. **Rust, inferring from witnesses.** Numbering succession, typography, bookmarks, page labels,
   geometry and note evidence are combined, and a decision comes from where they agree. This layer
   should already be right on clean, well-numbered documents.
2. **A fast model** inside Rust, for what the witnesses leave open.
3. **A quality model** for the hardest pages.

How much each layer does is not prescribed: it is decided by measuring speed and quality against
the gold, on a split that keeps related documents apart, without tuning to particular documents.

Rules for the code:

- Simple and stable. A crash on ordinary input is a regression. Machinery no consumer needs is
  removed, not maintained.
- Fast on a laptop CPU, with memory that stays flat on long documents.
- Structure logic lives in legal-structure and legal-pdf-parser; the apps bind to it. No
  TypeScript re-implementations, no Python mirrors of parser decisions.
- No compatibility shims or parallel old and new paths.

## The gold

The gold is one store with one set of conventions. The batch a gold was authored in (b5, b8, ...)
is provenance only: no convention, grade or pool depends on it.

`experiments/legal-structure-gold/author.py` makes one gold file per source PDF
(`legal-structure-gold.v4`). Each step has one decider, and no later step decides it again:

1. **Documents (the splitter).** Where the file's documents start, at a page or at a line partway
   down one, is decided before authoring by the page-stream splitter
   ([page-stream segmentation](../../experiments/page-stream-segmentation/README.md), its split
   annotation `{sha256, document_starts}`; `[]` for a file of one document). `author.py` requires
   it (`--splits`) and refuses a file without one. The gold records the starts it was cut at
   (`authoring.document_starts`).
2. **Lines (per page).** The model sees each page's image and extracted lines, with the pages
   either side as context, and gives every line in reading order with its region, whether it starts
   a unit, its printed markers (typed as printed) and its note reference marks, correcting misread
   text. Notes are paired by the parser's own pairer over the corrected lines.
3. **Document (per document, as cut).** Each document is authored alone: the model sees all its
   units and page images and gives each heading its level, every other body unit its depth (one per
   printed marker), and what the document is (`document_type`, from `prompts.DOCUMENT_TYPES`).
   The documents' golds are joined into the file's gold; each later document's first unit has
   `starts_document`.

What a document is, is read for parsing that document as cut: a schedule split off a contract is
authored and typed on its own pages. Where it came from is provenance, kept apart: the packet it was
cut from is its gold's file, and a source that is itself an excerpt of a larger PDF names that PDF
(`parent_sha256`, from the collectors through `provenance.mjs`; parent and child are kept in one
partition). A schedule, form or conditions of a contract is a contract (ruling of 2026-10-25): its
numbered paragraphs are provisions.

The runner aligns the typed lines to the extracted ones, records the corrections, spans, markers,
note pairs, levels, depths and reading order, and keeps the authoring extraction (line and word
boxes) beside the gold. The authoring extraction is never redone for later work: the inputs key
follows extraction only. Prompts stay small: they state the task and fix broad misunderstandings,
never edge cases. Model choice comes from measurement (gpt-6.1-sol at low effort).

`experiments/legal-structure-gold/gold_checks.py` holds the store to these conventions and runs over
the whole store at every integration (`--splits` with the splitter's annotations): `unsplit` (a gold
authored without a split annotation), `starts` (cut at starts the splitter has since changed),
`types` (a document type missing or outside the list), and within each gold the `recurring` and
`headings` consistency checks. A flagged gold is authored again (`--splits --again`), never patched
by hand. The grader (`experiments/legal-structure-gold/grade`) scores a parser build against the
store; the journal footnote gold (`experiments/footnote-gold`) scores footnote pairing.

The [OCR attribution experiment](../../experiments/ocr-structure-attribution/README.md)
analyzes all 359 completed sources from saved gold, without rerendering or OCR.
It reports errors by marker/reference kind, label shape and glyph confusion.
Separate optional native probes cover routing, proposals/filtering, crops,
resolution, CTC decoding and structural effects of transcription corrections;
five sources completed before that replay was stopped. Corrected text supports
recognition training; inherited line rectangles still need visual correction
before they become detector gold. Findings and retained receipts are linked from
the experiment.

Its crop-only A/B reused saved 144-dpi pixels. A corrected core-based glyph audit
reduced character errors from 85 to 62 on 232 scorable marker characters; the
subsequent 20%-to-10% white-margin test worsened errors from 63 to 67 on its paired
set of 234 characters. These are selected-page recognition results. The cached structure replay covered only five changed
lines and showed a small strict-metric regression; production linking improvement
is unproven. The strict note-reference metric also requires exact target-note
boundaries, so it is not isolated pairing accuracy or an OCR ceiling.

The [page-stream experiment](../../experiments/page-stream-segmentation/README.md)
is the splitter: it authors the split annotations every gold is cut at (Codex image requests over
each file's pages, unknown gaps preserved) and measures boundary models against them. Real-data
training, independent quality/calibration and end-to-end timing remain gates before a boundary
model enters the parser's tier 1.

## Out of scope

Court-record classification, affidavit processing and exhibit association keep their own runner.
Form fields, reading streams, quotation ownership scopes and other structure no consumer reads are
not modelled.

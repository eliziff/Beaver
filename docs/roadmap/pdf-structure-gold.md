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

`experiments/legal-structure-gold/author.py` makes one gold file per source
(`legal-structure-gold.v4`) in three passes. Every pass sees the page images.

1. **Lines:** the model sees each page and its extracted lines and gives the page's units, each a
   region and its printed lines (correcting misread text), with a tab after each printed marker
   and note references written with their printed mark as `[^mark]`; a flag says when a page's
   first unit continues the page before.
2. **Notes:** the model pairs every note reference with its note's number in the document's index.
3. **Hierarchy:** over the whole document at once (in windows only past the model's context), the
   model gives each unit that falls under another its parent, as row pairs, and, where the file holds several documents (a judgment with
   exhibits, a book of articles), where each starts and ends.

The runner aligns the typed lines to the extracted ones and records the corrections, spans,
markers, pairs, parents and the model's reading order, and keeps the authoring extraction (line
and word boxes) beside the gold so OCR, layout and parser models can train from it. Its receipt
counts recognition misses (typed lines matching no extracted line) and the engine's split and
merged lines, for the OCR census; the gold corrects recognition, never segmentation. Prompts stay small: they state the task and fix broad
misunderstandings, never edge cases. Model choice comes from measurement; gpt-6.1-sol at low
effort was chosen on a 120-page probe (lines) and on the journal footnote gold (notes: every one
of 457 gold pairs).

`experiments/legal-structure-gold/score_all.py` scores a parser build against the gold, feature by
feature. The journal footnote gold (`experiments/footnote-gold`) scores footnote pairing.

The [page-stream experiment](../../experiments/page-stream-segmentation/README.md)
prepares page-boundary labels from existing v4 document flags and original
affidavit/medical source maps. It stages bounded Codex image requests, preserves
unknown gaps, exports family-partitioned examples and measures boundary and
packet accuracy. A CPU tree baseline consumes existing Rust feature rows.
Within-page starts retain their span gold; no page boundary is inferred from them.
Real-data training, independent quality/calibration and end-to-end timing remain
gates before a boundary model enters the parser's tier 1.

## Out of scope

Court-record classification, affidavit processing and exhibit association keep their own runner.
Form fields, reading streams, quotation ownership scopes and other structure no consumer reads are
not modelled.

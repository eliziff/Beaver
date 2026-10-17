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

1. **Lines:** the model sees each page and its extracted lines, types every printed line with its
   region (correcting misread text), puts a tab after each printed marker, writes note references
   as `[^N]`, and gives the lines that start a unit, whether the page continues the one before,
   and where a separate document starts.
2. **Notes:** the model pairs every note reference with the line where its note begins.
3. **Hierarchy:** the model gives each unit its parent.

The runner aligns the typed lines to the extracted ones and records the corrections, spans,
markers, pairs and parents. Prompts stay small: they state the task and fix broad
misunderstandings, never edge cases. Model choice comes from measurement; gpt-6.1-sol at low
effort was chosen on a 120-page probe (lines) and on the journal footnote gold (notes: every one
of 457 gold pairs).

`experiments/legal-structure-gold/score_all.py` scores a parser build against the gold, feature by
feature. The journal footnote gold (`experiments/footnote-gold`) scores footnote pairing.

## Out of scope

Court-record classification, affidavit processing and exhibit association keep their own runner.
Form fields, reading streams, quotation ownership scopes and other structure no consumer reads are
not modelled.

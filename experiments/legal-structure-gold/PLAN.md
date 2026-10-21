# PDF structure gold

The gold runner sees each page already extracted (native text or OCR), with its image, in every
pass. A lines pass fixes the transcription and gives each page's units, each a region and its
printed lines; a notes pass pairs every note reference with its note; a hierarchy pass then gives
each unit of the whole document its parent and marks where each document of a multi-document file
starts and ends. Each schema carries what it can enforce (the region enum, one region per unit,
note by its number, parent by its row), so an answer the schema admits rarely needs a retry. One `legal-structure-gold.v4` file per source holds the
answer. The scorer measures a parser export against it. Runtime agent assistance and
[PageIndex reuse](../../docs/roadmap/pageindex-detection.md) remain separate work.

## Author

```powershell
python experiments/legal-structure-gold/author.py --pdf <pdf> --mode digitalborn|ocr [--out <dir>]
python experiments/legal-structure-gold/author.py --manifest <manifest.json> [--root <dir>] [--limit 0] [--shard k/n]
```

A manifest has `documents: [{path, mode}]`; paths resolve against `--root` or the manifest
directory. Defaults are gpt-6.1-sol/low, three bounded attempts and four concurrent
calls per source. Page images are rendered so the long side is 2,048 pixels (about 186 dpi for
a letter page; `--dpi` caps it at 300): measured on gpt-6.1-sol, that is the most the model
receives, and a 300-dpi render costs the tokens of about 215 dpi with no more detail. Output goes to `<out>/v4/<source-sha256>/` (`gold.json.gz`, `receipt.json`,
call receipts and page images); a complete receipt is reused on restart. Keep `--out` short: each
call runs codex in its attempt directory, and Windows refuses a working directory over 260
characters (WinError 267).
[Shared runner components](../../tools/codex_runner/README.md) own transport, accepted-response
caching, attempts and usage.

`extract.mjs` exports the installed parser's source lines with their extracted text, parsed
with the app's own PDF profile (`backend/src/lib/pdfProfile.ts`), which routes pages to OCR
as the app does.

The lines pass (`prompts.LINES`, three pages per call) gives each page's units in reading order,
each `{region, lines}` with the lines corrected against the image: text, list_item, heading, quote
(a block quotation), note, table (one row; cells joined by ` | `), contents, caption, headnote,
marginal_note, furniture or page_label. A tab follows each leading printed marker and `[^mark]`
writes a note reference with its mark as printed (a note's own leading mark is its label, never a
reference). A unit's first line starts it; a page's `continues` flag makes its first unit continue
the last unit of its kind on the page before. `blocks.py` aligns the
typed lines to the extracted ones: each typed line's source spans, cells, markers and references
over the corrected text, and OCR text edits where the typing differs (digital-born differences are
reported, not applied; canonically equivalent characters are no edit).

The notes pass (`prompts.NOTES`, three pages per call, with a numbered index of every note) pairs
every note reference, by page, line and mark, with its note's number, or 0 where none is printed.
Only pages holding a typed reference or a note line are asked about; a file without notes makes
no notes calls.

`hierarchy.py` groups typed lines into units and asks for each ranked unit's parent as `[row,
parent]` pairs (rows under none are left out, so nothing is positional) and, where the file holds
several documents, the units that start and end each one. The whole document goes in
one call with every page image while it fits the model's context (gpt-6.1-sol: 500k tokens; a
letter page at the 2,048-pixel long side costs about 3,800, so about 100 pages) and the codex command line (about
150 image paths); a longer document goes in windows that each fill those bounds, carrying the
still-open ancestors of the window before. Furniture, page
labels, marginal notes, notes and contents stay out of the outline.

A v4 file holds `images` [{page, bbox, fraction}] (the images the PDF places on its pages, read
from the file, never asked of the model: figures, stamps, scanned inserts), `lines` [{id, page,
text (extracted), corrected?}], `typed` [{page, region, text,
start, spans, markers, references, cells?}], `units` [{lines, parent, starts_document,
ends_document}], `notes` [{line, marker, reference, note}],
`text_edits` and a `report`: unanchored typed lines (text the model typed that matched no extracted
line, such as stamps and logos: recognition misses), unplaced and kept text, lines without typed
text, and where the extraction's segmentation differs from the print (`engine_split_lines`,
`engine_merged_lines`). The receipt carries the report's counts, so a cohort census reads receipts.

## Model probes (2026-10-17)

gpt-6.1-sol low against gpt-6-luna max, on the prompts of that day (the lines prompt has since been
shrunk; the shrunk prompts have only run on Sol). Luna is the cheap model, so the question is which
passes it can own, not which model wins.

Lines pass, 40 sources, 120 middle pages, three arms (A lines only, B lines with unit starts
inline, C a separate grouping call over A's lines):

| | Time (24-page slice) | Output tokens | Numbered lines marked as starts | Starts mid-sentence |
|---|---|---|---|---|
| Sol, B inline | 168 s | 13k | 23/23 | 0 (3 on 120 pages) |
| Sol, A + C | 250 s | 13k | 23/23 | 0 (3) |
| Luna, B inline | 504 s | 75k | 19/23 | 5 (129 on 120 pages) |
| Luna, A + C | 480 s | 65k | 23/23 | 0 (4) |

- Luna inline miscounts its own line numbers while typing lines and starts together, and drifts on
  transcription (modernised 1800s spellings, dot leaders rewritten as cells, marker tabs dropped on
  a monograph). Given the lines, its grouping pass is clean: 95% of numbered lines as starts, 25 of
  26 cross-page continuations.
- Luna labels every line of a multi-line list item `list_item` and a five-line italic title
  `heading` where Sol labels only the first; Luna labels inline quotations as block quotes (111
  lines on one page).
- Sol is 2–3× faster with about 5× less output.

Notes pass, 15 scanned journal articles, 151 pages, 457 gold pairs (`experiments/footnote-gold`):

| | Pairs found | Real errors | Time / output |
|---|---|---|---|
| Sol | 457/457 | 0 | 275 s, 5k tokens |
| Luna max | 452/457 | 12 (5 missed, 7 at a note's second line) | 386 s, 27k tokens |

Refresh on the current schemas (2026-10-18, seven short documents, 39 pages, one extraction, the
nested-unit, note-number and row-pair shapes): Luna max completed every document with no
rejected answer, found all 47 of Sol's note pairs and all 33 journal-gold pairs, and agreed with
Sol on 96–100% of regions and 97–100% of unit starts. It diverged on hierarchy in the two journal
articles (41/65 and 15/25 parents agreeing with Sol) and on the index (one unit per line where
Sol groups sub-entries). It produced 4.3× Sol's output tokens (129k against 30k) in 1.7× the
model time. Decision: the cohort is authored on Sol low throughout; Luna is not used for any pass.

## Cohort run

The cohort is the family selection (`benchmarks/local-data/legal-structure-gold/family-selection.json`,
with `family-selection-review.json`, `exposure-audit.json` and `exposure-review-before-audit.json`
beside it; all private and ignored). Build the manifest, then author in shards, then score:

```powershell
python experiments/legal-structure-gold/cohort_manifest.py --selection benchmarks/local-data/legal-structure-gold/family-selection.json --out benchmarks/local-data/legal-structure-gold/cohort-manifest.json --max-pages 500
python experiments/legal-structure-gold/author.py --manifest benchmarks/local-data/legal-structure-gold/cohort-manifest.json --limit 0 --shard 0/3
python experiments/legal-structure-gold/author.py --manifest benchmarks/local-data/legal-structure-gold/cohort-manifest.json --limit 0 --shard 1/3
python experiments/legal-structure-gold/author.py --manifest benchmarks/local-data/legal-structure-gold/cohort-manifest.json --limit 0 --shard 2/3
python experiments/legal-structure-gold/score_all.py --manifest benchmarks/local-data/legal-structure-gold/cohort-manifest.json
```

- Pin one engine for the whole run: set `LEGAL_STRUCTURE_ADDON` to a content-named copy of the
  release addon (`native/legal-structure-node/target/release/legal_structure_node.<sha256>.dll`)
  in every shard's environment, so a parser build during the run cannot change the extraction
  the gold is authored on. Structure-inference work can go on meanwhile; extraction and OCR changes
  wait for the run to end.
- Each shard is one process that runs its sources one at a time with four concurrent model calls,
  below normal priority. Three shards is the limit this laptop has borne; more has had background
  jobs killed for memory. A shard restarted after a crash skips every source with a complete
  receipt and reuses every accepted call.
- The manifest puts long documents first. Very large documents are left out for now
  (`--max-pages 500`): the 2,013-page book of authorities and the 1,058-page scanned bylaw. Their
  hierarchy pass would run in windows of 150 page images at several million input tokens each,
  and how to author very large documents is still to be decided. The longest kept is 478 pages.
- A source fails as a whole when a chunk's typed text matches under 30% of the extraction, or when
  a call is rejected three times. Both are recorded in its `receipt.json` (`status: failed`,
  `error`). After the run, list failed receipts and read each error before re-running any.
- Every receipt lists `pages_without_text` (pages the extraction read nothing from that are not
  blank: sideways, image-only or unreadable pages), written before any model call, so a census
  of unreadable pages needs only the extraction.
- Each complete receipt carries `report` counts: `unanchored_lines` (recognition misses),
  `lines_without_typed_text`, `engine_split_lines`, `engine_merged_lines`, `typed_differences`.
  Totals per mode are the OCR census.
- The score summary lands in `score/latest.json`; copy it aside before any parser change and use
  `--against` after. The manifest's `split` is what a frozen v4 evaluation must respect: train for
  development of the parser, development for choosing, test once.

## Score

```powershell
python experiments/legal-structure-gold/score_all.py [--out <dir>] [--manifest <manifest.json>]
python experiments/legal-structure-gold/score_all.py --against <earlier-summary.json>
python experiments/legal-structure-gold/evaluate.py --gold <gold.json.gz> --candidate <parser-export.json.gz>
```

`score_all.py` parses every completed `<out>/v4/*` source again with the most recently built
addon and micro-averages each layer into `score/latest.json`. PDFs come from the corpus, or from
the authoring manifest. Copy that summary aside before a parser change; `--against` reports the
change over the runs both scored. `--tag`, `--replay` and `--rescore` keep a run's engine inputs
for replay or rescoring without parsing.

`evaluate.projected` puts a v4 gold in the scorer's frame, so source alignment and feature
extraction read gold and parser export alike. Each unit becomes one block per fragment, with its
parent's first span as `parent`; fragments of one unit are linked by paragraph, heading or note
continuations (list items add a list continuation). The Rust grader cuts fragments from what the
source shows: a unit's spans in reading order, split at each page and at each line another unit
holds between them (Python split wherever the gold's typed spans of the unit were not adjacent,
an authoring detail no parser or label can see). List items are
text with a `list_item` locator and their marker; numbered text gets a paragraph locator. Block
quotes are running text. Notes are text inside a footnote annotation whose label is the note's
first marker; each reference is paired with the note the notes pass gave it. Table rows
consecutive in reading order (only furniture, page labels and notes between) form one table, one
grid per page linked across pages, each cell's text in reading order; a unit without text (3,826
in 563 golds) separates nothing. The first block opens the source's document and
each unit that starts a document opens another. Contents keep their own role and stay out of
the outline. The gold's reading order is the order the model typed the lines in (a line it never
typed keeps its place after the typed line before it), so the order layer scores the parser's
reading order against the model's. v4 lines carry no geometry, so that position stands for it; the
boxes live in the authoring extraction under `parsed/`, kept beside the gold.

Layers: text, coverage, order, roles, groups and joins (adjacent pieces of one logical block),
continuations (kind, no separator), hierarchy (unit, role, relation to the unit before, parent,
marker, and each field alone), notes (extent, label), note references, tables (extent, rows,
columns) and cells, document starts and document ownership. v4 records no quotation
annotations, reading streams, fields, resumptions, note kinds, separators, table headers or
merges, document kinds, relationships or facets, so those are not scored. Source-trace alignment
keeps exact coordinates for shared extraction lines and projects page-local Unicode spans for
different extractions, reporting coverage and split/merge counts apart from the scores.

Gold stays fixed when OCR changes. Its authoring line IDs locate reference annotations; candidate
lines need not have those IDs or the same segmentation. Cache new recognition separately by its
runtime/model identity and align its text to the reference before scoring structure. The
Rust grader in `grade/` uses the standard Myers implementation in
[`diff-match-patch-rs`](https://docs.rs/diff-match-patch-rs/0.5.1/diff_match_patch_rs/).
Exact unchanged witnesses bypass diffing; unique exact text anchors preserve identity when
reading order changes. Remaining text aligns within each page in Unicode scalar coordinates.
The comparison frame is the corrected gold text: projecting it back onto the authoring OCR
would lose characters inserted by corrections. Split and merged lines form connected components for
recognition scoring. Structural features still use the candidate's own order, groups and exact
annotation spans. Unmatched text remains an error. Matching is deterministic (no diff timeout
or line-mode heuristic). Repeated text can have multiple equally valid alignments; this is not
bit-for-bit parity with Python's `SequenceMatcher`.

Select predictions explicitly using the existing cache inventory:

```sh
structure-gold grade <gold-dir> <cohort-manifest.json> --candidates <gold-dir>/ocr-cache-state.json
```

The inventory's `inputs` rows name `source_sha256` and `candidate` export paths. Relative paths
resolve beside the inventory. Only listed documents are graded, test is excluded by default,
and a failed document makes the command fail after writing its report. `--exports` is the
authoring-export baseline, selected by the gold's recorded parser identity; default replay
uses the saved authoring extractions in `inputs/`. Neither is a refresh of OCR.
The desktop refresh keeps its new exports in `parsed/` alongside the authoring exports.
`ocr-cache-state.json` beside the cohort manifest records their binary, request, source identities
and unchanged gold hashes; `ocr-cache-jobs.json` and `ocr-cache-request.json` feed the existing
`extract.mjs --batch` runner.

This follows established practice: [Kraken recognition training](https://kraken.re/main/user_guide/training_recognition.html)
uses page images and corrected PAGE/ALTO line annotations, with compiled crops as derived data.
[Dinglehopper](https://github.com/qurator-spk/dinglehopper) compares extracted text for CER/WER;
its text sequence includes line breaks, and it does not replace structure or exact note-position
scoring. For differing segmentation,
[OmniDocBench](https://github.com/opendatalab/OmniDocBench#updates) keeps gold unchanged and adapts
the prediction's matching granularity. Match text independently of IDs, then score the candidate's
own grouping, order and relationships; alignment must not supply the answers being evaluated.

Rust grader validation (2026-10-19): six independent regression tests pass. The refreshed OCR
train/development subset (424 documents, 2,190 pages) grades in 1.4 seconds on the desktop,
with no errors and all gold file hashes unchanged. Accumulated alignment time averages
1.56 ms per page. This measures cached exports through grading; it excludes PDF extraction
and OCR. The recorded OCR cache-fill batch took 906.5 seconds for all 453 OCR documents,
including export overhead; it is a separate measurement.

## Paragraph model (2026-10-19)

`structure-gold paragraph-data GOLD_DIR MANIFEST OUT_DIR` exports the Rust reader's adjacent body-line
witnesses and boundary targets aligned to the fixed gold. Mixed-unit or weakly aligned lines
are omitted. Test sources are excluded. The reviewed family selection matches all 1,092
exported train/development sources; 1,053 have eligible pairs (110,125 train, 121,692 development).
The frozen dataset and evaluation stay in private `paragraph-model/` under the gold directory.
Its dataset SHA-256 is `d0ecc9c4d95e9a6eee277f8c7a70411f2b687b2e81e1de22f6a3940277684d14`.

Train with `python train_paragraphs.py OUT_DIR/dataset.json --out OUT_DIR` from this directory.
The scaler fits train only; PyTorch trains logistic and 30→32→1 ReLU models with weighted binary
cross entropy, AdamW and seed 7. Development selects the model and a conservative merge threshold
at 95% minimum precision. On the desktop RTX 3080 Ti, optimization took 0.76 and 0.54 seconds
respectively, excluding data loading and imports. The MLP's boundary-only development F1 is
0.8740 against the Rust baseline's 0.8499: 1,479 correct repairs among 1,554 proposed merges.
These are proposal metrics. The conservative Rust integration kept strong geometry, indentation,
enumerator and native-type boundaries, but its actual development group F1 moved only
0.68528→0.68529 (train 0.44440→0.44460). Notes and references were unchanged. This does not justify
shipping its inference code. `score/parser-before.json` and `score/parser-after.json` retain the
1,092-document comparison: 14.2 and 15.9 seconds, zero errors, cached recognition throughout.

The experimental weights stay in private `paragraph-model/model.json`: 1,025 parameters,
SHA-256 `d39c10ed61444f2559df85cea7338b6a01df9bfd3122d582bdf0b14521f7027c`.
Reproduce them from the frozen dataset: regenerating features after changing paragraph
segmentation creates a different experiment. The model proposals concentrate on same-row text
fragments. The retained paragraph correction reuses the extractor's existing MuPDF 0.8-em
spacing invariant in paragraph grouping; the ineffective model runtime was removed.

## Parser candidate (2026-10-20)

The final outline assembler now consumes the heading reader's inferred levels, retaining its
style fallback, bookmark overrides and document/quotation contexts. Numeric, enumerator and
hierarchy marker extents exclude trailing separator whitespace without moving content starts or
layout padding. Paragraph grouping joins adjacent fragments of one printed row, while retaining
indentation, numbered-item and column boundaries. This changes structure, not recognition.

`score/parser-before.json` and `score/fragments-after.json` compare the same 1,092 completed
train/development sources with fixed cached recognition and fixed gold; neither uses test.
The intermediate hierarchy-only candidate is `score/hierarchy-after.json`.
Reproduce a comparison with `structure-gold grade GOLD_DIR MANIFEST --out REPORT --against BASELINE`.
All 1,092 gold and input hashes still match the frozen training manifest. The measured binary's
SHA-256 is `f99c68b5aa8005d39b132ede7339b81461dc356caac5651a5e61b0a42e296be7`.

| Development F1 | Before | Final |
| --- | --- | --- |
| Complete hierarchy assignment | 0.05891 | 0.10717 |
| Parent links | 0.20152 | 0.20415 |
| Marker spans | 0.13690 | 0.71200 |
| Unit starts | 0.77040 | 0.77165 |
| Grouping | 0.68528 | 0.68625 |

Most of the complete-hierarchy gain is marker correctness; parent inference remains weak.
Grouping improves in 82 sources and worsens in three; train grouping F1 moves 0.44440→0.45391.
Development grouping improves for native-text sources (0.71988→0.72062) and OCR sources
(0.32233→0.32403). Note extents and note-reference scores do not change. Two additional
cross-page paragraph continuations in scans disagree with the gold; these are retained as
measured regressions, not repaired by rewriting the reference. Final structure replay plus
grading takes 16.7 seconds, with zero document errors; PDF extraction and OCR are excluded.

Validation: owning-crate checks, marker-offset tests including indented Unicode input, typed
numeric/hierarchy tests, heading/context/navigation tests and seven grader/training-target tests
pass, as do 12 cache-provenance mutations and DOCX isolation. The structure library has 44
passing tests, two ignored corpus tests and two existing heading-boundary failures
(`heading_and_utf16_edges_match_javascript`, `instrument_heads_keep_token_and_heading_boundaries`);
both also fail with the original marker extents restored. The final PDF-structure library has
91 passing tests and two pre-existing furniture
failures (`a_running_head_naming_each_page_s_sections_is_furniture`,
`attached_top_note_labels_are_not_repeated_headers`); both also fail with the paragraph model
disabled. Stale fixture fields, missing test engine installs and omitted region-view rebuilds
were corrected without changing expected outcomes. Held-out evaluation and app-addon delivery
remain separate gates. The plan's next target is region/role and unit-relation inference, which
the parallel Claude work owns along with notes and tables.

## Tier-1 line tagger (2026-10-20)

`structure-gold rows GOLD_DIR MANIFEST OUT_DIR` replays the parser over each train and
development gold's inputs and writes one JSON document per piece of `OUT_DIR/rows-<split>.jsonl`.
A piece is a line cut at every boundary of the frame's blocks (most lines are one piece; OCR lines
that run a margin note into the body, two table rows or two notes are several). Each piece, in
the parser's reading order, carries its line's evidence (geometry, typography, the readers'
flags), its own text shape and place in the line (`rows::FEATURES`), the parser's labels (tier
0) and the gold's, carried onto the parser's pieces through the scorer's alignment. A piece's
labels: its unit's region (the gold's 12 regions, or none); whether it opens a unit, continues
the unit open in its stream (body, notes, margin notes, furniture, page labels) or resumes an
earlier unit, which it points at; on a unit's first piece the unit it falls under, pointed at;
the relation that parent makes to the ranked unit before (first, child, sibling, up 1 to 5,
other); whether another document opens on it; and whether a paired note reference sits on it.
Pointers are rows (-1 for none). `labels.rs` reads them alike from the gold and from the
parser's composition. 1,092 documents export in about 19 seconds.

`structure-gold grade ... --labels FILE` scores a tagger's labels ({sha256, ids, labels} per
document, ids naming pieces as `line@offset`): it decodes them into the gold's own form over the
replayed parser's pieces, which supply what labels do not say (markers, note references, the
notes they pair with, table cells). `structure-gold selfcheck GOLD MANIFEST self|labels
[--worst LAYERS]` scores the gold against itself and the gold's own labels decoded over the gold:
both read 1.0000 on every layer over all 1,092 train/development documents, so a perfect
tagger scores 1.0 and every shortfall is the parser's frame or the model. Relations read one
unit after another had cascaded (the gold's own labels gave parents 0.758); parents are pointed
at instead. `explain SHA --roundtrip` and `explain SHA --tree` show a round trip's or the
parser's own node tree.

`train_tagger.py ROWS_DIR --out DIR --model gru|transformer` trains a sequence tagger on the
desktop GPU (character CNN, feature projection, two-layer BiGRU of width 128 or a four-layer
transformer, five heads); `train_trees.py` trains LightGBM per head over each line and its two
neighbours on each side. Development selects epochs and trees; test is not read.

Development (381 documents), pooled F1. The parser's frame bounds what any tagger over its pieces
can reach: the gold's labels carried onto them and decoded (the frame's ceiling) keep the
parser's reading order, cuts, markers, notes and grids.

| Layer | Parser | Gold labels on the parser's pieces |
|---|---|---|
| order | 0.835 | 0.850 |
| roles | 0.837 | 0.967 |
| groups | 0.686 | 0.913 |
| hierarchy | 0.108 | 0.717 |
| hierarchy_units | 0.773 | 0.989 |
| hierarchy_roles | 0.551 | 0.966 |
| hierarchy_parent | 0.206 | 0.979 |
| hierarchy_marker | 0.712 | 0.738 |
| note / note_references | 0.498 / 0.554 | 0.661 / 0.741 |
| table / table_cells | 0.100 / 0.215 | 0.142 / 0.286 |

The model results below were measured with the cascading relation encoding, whose own ceiling
was parents 0.713; they are superseded until retrained on pointers. Per-line development
accuracy, tier 0 → trees: region 0.688 → 0.827, start 0.896 → 0.969,
relation 0.548 → 0.697. Earlier, without the unit context, the BiGRU (0.70M parameters) read
region 0.777, start 0.947, relation 0.687 and the transformer (1.42M) 0.719, 0.939, 0.608; the
trees were smallest and best on most layers, the GRU best on cross-page continuations. Trees
train in about 4 minutes on the desktop CPU. Keeping the parser's units and regions and taking
only the trees' relations already moves parents 0.205 → 0.292.

Tried and set aside: `train_relations.py` reads each unit's relation against its own decided
ancestor chain (0.770 when the chain is the gold's) but compounds its errors end to end (0.675;
parents 0.365, relations 0.586), so the per-line trees stay.

## Notes (2026-10-20)

A bare or bracketed number opening a body-zone line in body type with prose beside it is a
section, subsection or paragraph number, not a note's label, unless its text reads as a
citation (an endnote list). 1,092 train/development documents: note 0.330 → 0.348,
note_references 0.372 → 0.396 (29 better, 4 worse); the journal footnote gold
(`olj_pairing`, 95 articles) is unchanged (labels P 0.9885 R 0.9727, references P 0.9931
R 0.9535). Still open: Westlaw printouts in books of authorities set their calls at 8⅓ points
over 10 (0.833 of the line, above extraction's 0.82 superscript limit), and the pairer takes one
label chain for the whole PDF, so each judgment's restarting end list is rejected as overlapping
it; and statutes' source-history notes carry no label. Splitting the label candidates into
blocks at every note-region "1" after the numbering has run on (each block choosing its own
runs) costs the journal gold dearly (label recall 0.9727 → 0.7000), so a compilation's judgments
need a narrower boundary than a restart.

## Numbering-family nesting (2026-10-20)

The PDF outline assembler now follows the shared text parser's existing numbering-stack rule:
a different family opening at its first value nests under the open numbered item. For example,
`4. ? (a) ? (i)` nests without requiring a colon; an existing family resumes as a sibling and
closes its descendants. Headings and document/quotation contexts retain their boundaries.

Measured with the corrected gold projection in Beaver `5fc8f7438`, including Claude's committed
note correction and current cached-input reader. Both candidates use the same 1,092 train and
development sources. The gold self-check scores 1.0 on every layer; all 1,092 gold and input
hashes match the frozen paragraph dataset.

| Development F1 | Before | After |
| --- | --- | --- |
| Complete hierarchy assignment | 0.10819 | 0.12438 |
| Parent links | 0.20600 | 0.22382 |
| Relations | 0.44281 | 0.45227 |

Train parent F1 improves 0.20521?0.21330. Development parents improve for digital-born sources
(0.21260?0.23190) and OCR sources (0.13824?0.14086). Across both splits, parent F1 improves in
85 documents and worsens in three; complete hierarchy improves in 76 and worsens in two.
Other scored layers are unchanged. Review of the regressions shows upstream unit/role mistakes
can still turn standalone heading markers, split section markers or numbered notes into parents.

The owning crate's metadata checks and both outline behavior tests pass, including nested
Roman/alphabetic counts, sibling resets, noninitial counts, headings and document separation.
The file already fails rustfmt at the baseline; its surrounding formatting is retained.
Private receipts live in `score/codex-numbering/` beside the gold: `before.json`, `after.json`,
`comparison.json`, input-hash verification and check logs. The tested binary SHA-256 is
`e50b1da2beeb28f758f0056295f5d395027b8b5118e285b7a4f37f677820b9e9`.
The final replay and grading takes 17.0 seconds, with zero errors. This excludes extraction/OCR;
held-out evaluation and addon delivery remain pending.

## Heading detection first (2026-10-20)

Establish which text is a heading before further level or parent tuning. The previous
numbering-family gain does not address missed headings. `heading_detection.py` measures this
over all aligned parser pieces in the existing Rust row export, using the complete 711-document
train and 381-document development splits. It excludes unit-stack and outline-level features.
The fitted models are line-feature baselines, not trained visual layout models.

| Development aligned-piece heading F1 | Existing reader | Line features and neighbours |
| --- | --- | --- |
| Digital-born | 0.72245 | 0.83172 |
| OCR | 0.18040 | 0.58221 |

The word/character TF-IDF branch and its mean ensemble do not improve the OCR result. These
scores omit unknown alignments and do not measure complete heading spans or recognition
misses. They are diagnostic evidence, not sufficient parser quality. The immutable input
hashes, model weights and results are private under `heading-detection/` beside the gold.

The installed layout pack is `docling-layout-heron-int8-stock`; it has not been fine-tuned on
this cohort. An earlier development layout attempt completed only 14 of 114 documents, with
100 runtime errors, so its aggregate is not a complete layout result. A corrected cache pass
uses the same ONNX Runtime library for OCR and layout and the Indra-capable addon: all 115
completed development OCR documents, 386 pages, finish without errors. This establishes cache
coverage, not accuracy. Recognition and extraction are hard-linked from the existing cache.

The structure reader also discarded explicit layout heading labels while reclassifying text
by font size. Recognized lines have no font spans. The parser now retains `paragraph_title`,
`doc_title` and `heading` evidence before that fallback, while its existing table, running-text
and false-heading handling remains in place. Native-addon compilation passes; end-to-end
measurement remains outstanding. A reconstructed replay failed native-output parity and is
not accepted as candidate evidence.

`train_heading_layout.py` prepares standard COCO heading boxes from fixed gold and its
authoring geometry, referencing the existing pinned page images. Run:

```sh
python train_heading_layout.py prepare --gold GOLD_DIR --inputs FROZEN_INPUTS --out PRIVATE_MODEL_DIR
python train_heading_layout.py train --gold GOLD_DIR --out PRIVATE_MODEL_DIR
```

Of 711 completed training documents, 698 contribute 3,826 pages and 5,224 heading boxes.
Ninety-eight pages have a gold heading without usable source geometry and are excluded rather
than labelled as negative; 13 documents consequently contribute no page. The projection records
each exclusion and source gold/geometry hashes. It does not regenerate gold or read development
or test documents. Pages without headings remain in training.

The visual model follows the [Transformers object-detection training pattern](https://huggingface.co/docs/transformers/tasks/object_detection),
starting from [Docling Heron](https://huggingface.co/docling-project/docling-layout-heron).
It retains the pretrained backbone, transformer and section-header classifier channel, including
the denoising embedding; all tensors load strictly. Training uses AdamW, mixed precision, five
epochs, cosine decay and the existing desktop GPU. Only the latest resumable epoch checkpoint
is retained. The one-class experimental detector is not a replacement for the full layout
provider. Training performs no evaluation or test runs, per the user's instruction; its quality
is unmeasured. Dataset provenance, initialization and training artifacts live under private
`heading-layout-training/` beside the gold. The first five-epoch run completed in 48 minutes
with resumable `checkpoint-2395`; its receipt confirms no evaluation or test run.

The Rust heading reader no longer requires complete external layout labels before reading
numbering and capitals. The existing grammar and prose-flow rules now run for unlabelled
inputs too. Known source labels are retained per line, so an unknown peer no longer removes
heading, note or table evidence. Unknown labels are omitted, preserving the witness reader's
per-line `layout_known` meaning. Completeness is checked separately for the body-font estimate.
Detected tables, notes and contents remain excluded from headings. The typography
reader previously accumulated only font spans, leaving recognized lines with zero characters
and empty geometry.
It now reads their text and boxes, using measured glyph height as the available size witness
without inferring a font face or bold/italic styles. Wrapped titles can use matching measured
line heights without font spans. Numbered blocks the ladder did not accept can now face the
existing typography checks instead of being excluded by their number alone; prose, spacing
and repeated-style filters still apply. The existing source fingerprint invalidates the
reader cache.
Document-level context must inform local heading, footnote and list decisions. Heading
statistics, blocks, wrapped joins and body/neighbor/style context now use one inclusion mask,
excluding known notes, furniture, captions, tables and contents. An excluded line
parts a source block instead of invalidating eligible text beside it. Native italic flags survive
into the style reader even when an embedded font's name gives no style. Existing document style
and numbering readers remain the heading context.
The note reader learns separate document profiles for native font sizes and recognized glyph
heights; OCR can now contribute to the existing note-type strand reader without borrowing a
native font-size baseline. Its separator, label-sequence and continuation witnesses remain in
force. Note correction now scopes those profiles, label ladders, page-end layout priors and
continuation bridges to the detected document and language views. Separators map by physical
page identity into each view. Table-owned content and confirmed contents body rows provide no
profile or promotion evidence. Original source flags are restored after the pass.
Rejected or immutable text closes the rerouting chain. New footnote claims also carry the mode
flag the pairer uses to recognize page-local numbering restarts.
Final note-mode inference, recognition label repair and reference pairing now use those same
contexts. Pairing results merge with unique PDF-wide pair and sequence ids while retaining
source anchors, physical page numbers and reading-order display occurrences. Cross-note links,
unmatched-reference evidence and carried proposition text use the owning document and language;
ambiguous links remain unresolved. Physical page gaps close final note-mode history. The shared
engine's existing introductory-symbol rules count from the input document's first page, so an
embedded document retains those witnesses without renumbering its physical pages.

Font-based heading claims now calibrate against long native prose on the current page before
using that document's estimate. The existing paragraph geometry algorithm supplies read-only
paragraph assignments before font-heading claims and the final paragraph groups afterward. Paragraphs
longer than the existing font-heading length limit establish local body type through the same
character-mass estimator; sparse pages retain the document prior. Both plain font promotion and
numbered-heading visual decisions use that baseline, and known non-heading source roles veto
the font fallback. Fontless OCR skips this extra geometry pass. This targets the compound-file
failure where a constituent's larger body font was read as a heading on every prose line; the
reported document has not been rescored for this candidate.

The existing lexical constituent openings now scope heading inference before final hierarchy
assembly. The same openings drive the final constituent nodes, per-document/language font
priors, numbering, typography, paragraph segmentation and bookmark frames. The existing readers
run on page views containing one context's lines, then restore physical order and keep block
groups distinct between contexts. Text, line ids, anchors and geometry are retained. Ordinary
monolingual documents without another constituent use the direct path. Font-only candidates
retain the classifier's note, table, paragraph and source-role vetoes and are not cached.
Initial page classification now uses those boundaries too: endnote, table, contents and
language evidence is read independently for each detected document. Painted table rules and
physical page identities survive the views, and separators follow page slots rather than
assuming zero-based physical indices. Missing pages close continuation histories. When a page
holds more than one document, contents evidence follows the owning lines instead of excluding
the other document's text. Known source notes, tables and furniture cannot open constituents.
Furniture and detached-reference inference now use two passes for compound PDFs. Discovery
retains the prior filters; final repetition, folio, type and host evidence is recomputed within
each detected document from the original source fields. Provisional exclusions and appended
references are discarded first. Single-document PDFs reuse discovery's decisions. Detached
references respect existing exclusions, and their separators follow page slots too.
Initial line-role inference now runs in each parallel-language view too, using the same note
band reader. Body/note type, label ladders, reference witnesses, suppression and continuation
history stay within the language. Table inference still sees the full page; physical reading
order and table ordering run after the language views are restored. One column's earlier note
band therefore no longer supplies the cutoff for the other column's body text.
Printed-paragraph candidates now use the retained document/language contexts for numbering
sequences, margin bounds, paragraph groups and marker selection. Repeated numbers in another
constituent no longer force the ambiguous-occurrence fallback. Candidate ids remain PDF-wide;
empty page views preserve gaps without borrowing another context's text. Body paragraph joins
also require adjacent physical pages.
Paragraph assembly now uses the retained document/language map too, with one continuation
tail per context and one first passage per context on each page. Intervening parallel text
no longer interrupts the other language's continuation. Mixed regions split at context
boundaries before the existing text, source-span and note-anchor renderer runs. Numbered
paragraph candidates consume that same assembler without a second group-splitting pass.
Display quotation inference also uses borrowed row/page views per retained context. Row
assembly, margins, typography and carried blocks stay within the document and language;
contents and table-owned notes do not train its body profile. Introductions and continuation
require the same or next physical page. Scope ids retain the original first-line identity.
Grammar and citation readers now use one retained context at a time. Their temporary text
views preserve scalar positions and line boundaries, so anchors project to the original index.
Candidate and parent ids remain unique across views. Paragraph stops, body measures, lexical
lead-ins, prose witnesses and citation projections use the same context. Final units intersect
envelope ranges with owned line fragments and scoped marker fragments before outline assembly,
keeping explicit source membership through interleaved columns.

Short titles set apart by bold or capitals can now reach the existing heading reader without
requiring a font-size change. This adapts the existing type proposals from Claude's parser work,
retaining source exclusions, prose-flow, layout and citation checks. A colon-ending title needs
that stronger type evidence. Explicit native heading levels retain their authority.
Parallel English and French texts retain both heading sequences. The restart-aware numbering
reader, body-font calibration, wrapped titles, page caps and final parent stacks keep the two
sequences separate. Document, quotation, note and table-cell boundaries remain in force.
Bookmark title anchors, parent stacks, duplicate-title counts and frame backfill now use the
same sequence boundary. Unanchored entries guide the primary frame only; explicit native Hn
levels survive bookmark backfill. The style reader gives accepted headings and inner ladder
steps separate blocks before region assembly, retaining wrapped lines at one level together.
A section that opens with its first subsection in one unit now holds later sibling subsections
and their marginal notes. This adapts Claude's existing section fix, using the shared numbering
grammar and one open section per context in a linear pass. A heading or later section closes it.

List evidence reuses the existing lead-in lexicon, adding lowercase clause openings, commas,
semicolons and trailing `and`/`or` to aligned, consecutive sibling markers with a shared parent.
A recognized lead-in carries over the sibling sequence across page breaks; an ended item or
broken alignment stops it. Clause syntax has its own observation and resolution proof, and can
support short or noninitial lists where the existing paragraph/provision rules leave the role
unresolved. Siblings with different parents or document contexts no longer supply each other's
alignment or lead-in witnesses.

Native PDF heading roles now reach the reader too. Extraction walks the existing Inspector
structure-tree view and retains enclosing `H`/`Hn` roles through inline spans and links, keeping
the direct inline roles intact. A heading claim must cover the complete line with exact source
span anchors; mixed or untagged prose cannot inherit a run-in title's role. Conflicting MCID
claims supply no heading evidence. Raw source labels retain standard PDF `Hn` levels, while
final line roles remain canonical `heading`. PPDoc preserves these native labels, the region
reader accepts them, and the style reader retains their explicit levels instead of re-inferring
them. Wrapped-title grouping respects differing tagged levels. Existing furniture and table
handling retains its precedence; parallel text has its own heading context. The role convention
follows the
[PDF Association's standard structure elements](https://pdfa.org/download-area/cheat-sheets/StandardStructureElements.pdf).

Frozen extraction inputs can exercise direct tags already retained in font spans, but cannot
recover enclosing heading roles that an older extractor discarded. That coverage requires
refreshed native extraction; the independent gold stays fixed and recognition caches remain
separate. The extraction and reader fingerprints cover these source changes.

Parser commits through `d65b0c8` and structure commit `07e7b33` pass affected-crate
`cargo quick` checks. Full-feature addon compilation also passes. The optimized addon is rebuilt
from this candidate using `npm run native:build -- --release` in the canonical target directory.
New code follows rustfmt; existing formatting differences elsewhere in the touched files are
retained. No tests or candidate scoring were run under the user's current instruction; quality
remains unmeasured.
Compound openings still rely on the existing lexical detector.
Candidate witness typography/repetition profiles and the final outline body-size baseline
still pool input pages.

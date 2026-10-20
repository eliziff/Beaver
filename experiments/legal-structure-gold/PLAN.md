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
extraction read gold and parser export alike. Each unit becomes one block per fragment (its lines
on one page, unbroken), with its parent's first span as `parent`; fragments of one unit are linked
by paragraph, heading or note continuations (list items add a list continuation). List items are
text with a `list_item` locator and their marker; numbered text gets a paragraph locator. Block
quotes are running text. Notes are text inside a footnote annotation whose label is the note's
first marker; each reference is paired with the note the notes pass gave it. Consecutive table rows (only furniture, page labels and notes between) form
one table, one grid per page linked across pages. The first block opens the source's document and
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
development gold's inputs and writes one JSON document per line of `OUT_DIR/rows-<split>.jsonl`:
each source line in the parser's reading order with its evidence (geometry, typography, text
shape and the readers' flags, `rows::FEATURES`), the parser's labels (tier 0) and the gold's.
A line's labels are its region (the gold's 12 regions, or none), what starts on it (inside, a
unit, a continued fragment), its unit's relation to the ranked unit before (first, child,
sibling, up 1 to 5, other), whether another document opens on it, and whether a note reference
sits on it. `labels.rs` reads them alike from the gold and from the parser's composition.
1,092 documents export in about 16 seconds.

`structure-gold grade ... --labels FILE` scores a tagger's labels ({sha256, ids, labels} per
document): it decodes them into the gold's own form over the replayed parser, which supplies
what labels do not say (markers, note references, the notes they pair with, table cells).
A line that starts a unit opens one; the others join their region family's open unit; a unit's
lines are typed together; parents follow each relation up the ancestors. Decoding the parser's
own labels reproduces the parser within 0.005 on every layer but tables and notes, and decoding
the gold's labels gives the encoding's ceiling.

`train_tagger.py ROWS_DIR --out DIR --model gru|transformer` trains a sequence tagger on the
desktop GPU (character CNN, feature projection, two-layer BiGRU of width 128 or a four-layer
transformer, five heads); `train_trees.py` trains LightGBM per head over each line and its two
neighbours on each side. Development selects epochs and trees; test is not read.

Development (381 documents), pooled F1. The hybrid takes the model's regions, starts and
relations and keeps the parser's notes, references and document starts; tables do not survive
label decoding yet (the parser's grids would stay in a Rust integration).

| Layer | Parser | GRU hybrid | Trees hybrid | Gold labels (ceiling) |
|---|---|---|---|---|
| roles | 0.837 | 0.883 | 0.897 | 0.968 |
| groups | 0.685 | 0.698 | 0.745 | 0.910 |
| hierarchy_units | 0.772 | 0.843 | 0.873 | 0.987 |
| hierarchy_roles | 0.550 | 0.710 | 0.741 | 0.987 |
| hierarchy_relation | 0.442 | 0.567 | 0.578 | 0.866 |
| hierarchy_parent | 0.203 | 0.346 | 0.345 | 0.713 |
| continuations | 0.306 | 0.476 | 0.309 | 0.916 |
| note / note_references | 0.498 / 0.554 | 0.497 / 0.554 | 0.497 / 0.554 | 0.655 / 0.743 |

Per-line development accuracy (tier 0 → GRU, 0.70M parameters → transformer, 1.42M → trees):
region 0.688 → 0.777 → 0.719 → 0.801; start 0.895 → 0.947 → 0.939 → 0.966; relation 0.549 →
0.687 → 0.608 → 0.678. The trees are the smallest and best on most layers and evaluate in pure
Rust; the GRU's continuations show what wider context adds. Training takes about 2 minutes
(trees, CPU) and 8 minutes (GRU, GPU).

## Notes (2026-10-20)

A bare or bracketed number opening a body-zone line in body type with prose beside it is a
section, subsection or paragraph number, not a note's label, unless its text reads as a
citation (an endnote list). 1,092 train/development documents: note 0.330 → 0.348,
note_references 0.372 → 0.396 (29 better, 4 worse); the journal footnote gold
(`olj_pairing`, 95 articles) is unchanged (labels P 0.9885 R 0.9727, references P 0.9931
R 0.9535). Still open: Westlaw printouts in books of authorities set their calls at 8⅓ points
over 10 (0.833 of the line, above extraction's 0.82 superscript limit), and the pairer takes one
label chain for the whole PDF, so each judgment's restarting end list is rejected as overlapping
it; and statutes' source-history notes carry no label.

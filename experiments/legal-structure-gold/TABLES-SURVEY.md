# Tables on scanned pages: survey (2026-10-22)

Question: how should the legal-pdf parser get table cells right on scanned pages? Should it keep the
existing detectors, add a model tier for scans, or extend the pdf-inspector whitespace heuristics?
This was an experiment only. No parser code changed.

Data: v4 structure gold (desktop store `C:\Users\elias\Desktop\oajd_compute\lsg-v4\benchmarks\local-data\legal-structure-gold`),
main yardstick (`C:\Users\elias\fable\groups.json`), parser labels from the r8 rows export
(`C:\Users\elias\fable\rows-r8`). All compute ran on the desktop (RTX 3080 Ti, Ryzen 5 2600X).

## What a gold table unit is

The gold prompt types a table as **one unit per row, with cells joined by ` | `** (`prompts.LINES`).
So a "table unit" in the rows export is a row, not a cell. The typed lines carry `cells`, the spans
of each cell. On main dev+train, 737 of 1,151 table units have side-by-side lines (rows that span
columns), 201 are single lines and 213 are stacked lines in one column. This survey therefore scores
two things:

- **Row agreement:** a gold row unit counts as matched when all of its pieces fall in one predicted
  row and no other gold piece on the page falls in that row.
- **Cell agreement:** the same test applied to gold cells. Each gold cell is built from the typed
  `cells` spans, and its pieces get word-level boxes from `inputs/<sha>.json.gz`.

**Grader issue found (not fixed).** `grade/src/state.rs` builds the gold grid by each cell's
position within its typed line. Some typed lines have fewer cells than their row, for example the
wrapped continuation lines of a value cell. For those lines, cell 0 is the leftmost cell, so the
text goes to column 0. In the 25 documents below, 285 cell pieces sit on such lines. For 232 of
them, the column that geometry gives is not the column the grader uses. In this survey, a short
line's piece goes to the row column it overlaps most horizontally. Under the grader's convention,
TATR's cell agreement drops from 38.3% to 35.3%. The official `table_cells` score is understated by
the same mechanism for any parser that gets those cells right.

## 1. Census: gold table units the parser misses (main yardstick, dev + train)

"Parser table page" means at least one tier-0 row on the page is labelled table. "Missed" means no
row of the unit is labelled table.

| mode / split | gold table units | on parser-table pages | on pages with no parser table | missed (no row labelled table) |
|---|---|---|---|---|
| digital-born / dev | 107 | 83 | 24 | 24 |
| digital-born / train | 251 | 108 | 143 | 207 |
| OCR / dev | 335 | 159 | 176 | 222 |
| OCR / train | 458 | 62 | 396 | 401 |
| **total** | **1,151** | 412 | 739 | **854** |

The parser's table units almost never equal a gold row: 16 of 1,151 units match exactly.

**Missed units by whether the page has vector lines** (pymupdf `get_drawings`, counting `l` and `re`
items): none = 0, few = 1–3, ruled = 4 or more.

| page kind | missed units | share of misses |
|---|---|---|
| OCR, no vector lines | 600 | 70% |
| digital-born, ruled (lines or rects present) | 140 | 16% |
| digital-born, no or few lines (whitespace tables) | 91 | 11% |
| OCR, ruled or few | 23 | 3% |

Scans without lines dominate the misses. Digital whitespace tables are 11%, so option (iii) is not
supported. A separate finding: 140 missed units sit on digital pages that do have lines (124 of them
in train, mostly municipal bylaw and receivership pages). There, the existing line and rect detectors
do not fire, or their output does not become table labels. That gap is not about scans.

**Top 15 documents by missed units**:

| sha256 (prefix) | split | mode | source_family | genre | gold units | missed | pages with missed units | vector lines on those pages |
|---|---|---|---|---|---|---|---|---|
| eab433e945b8 | dev | ocr | cfcanada.fticonsulting.com | contract | 170 | 88 | 14 | none |
| 033c0d76209f | train | ocr | canadiana-legal-monographs | rules_or_regulations | 74 | 74 | 7 | none |
| d5d56b4a36b1 | train | ocr | cfcanada.fticonsulting.com | contract | 67 | 50 | 3 | none |
| 0a55ce238cae | train | ocr | irac.pe.ca | contract | 46 | 46 | 3 | none |
| b40f75c1ef13 | train | digital | mnpdebt.ca | contract | 42 | 42 | 3 | none (15 images: tables are pictures) |
| 1efdff9f59b3 | train | ocr | www.bdo.ca | contract | 40 | 39 | 2 | none |
| 3c2e8e2c74c5 | train | ocr | cfcanada.fticonsulting.com | contract | 42 | 34 | 7 | none |
| eb68df303cea | train | ocr | cfcanada.fticonsulting.com | contract | 32 | 32 | 5 | none |
| 26d54f641967 | train | ocr | cfcanada.fticonsulting.com | contract | 28 | 24 | 5 | none |
| aa6758647ead | dev | digital | www.ksvadvisory.com | contract | 37 | 21 | 6 | 4 of 6 pages (rects, up to 643 lines) |
| 820c7c83eda4 | train | digital | court-practice/ca | brief | 21 | 21 | 7 | 7 of 7 (4–18 lines: rules or underlines) |
| 2dadcc21c83a | train | digital | mississauga-zoning | municipal_bylaw | 21 | 19 | 1 | yes (18,792 lines) |
| 42870bf196c0 | train | digital | mississauga-zoning | municipal_bylaw | 21 | 19 | 1 | yes (same page as above) |
| 46f7dc846340 | train | digital | hamilton-zoning | municipal_bylaw | 19 | 19 | 3 | 1 rect per page |
| 7e5cc000b507 | train | digital | mississauga-zoning | municipal_bylaw | 21 | 19 | 1 | yes (same page as above) |

The three Mississauga documents carry an identical table page.

## 2. Models on the 25 documents

**Documents (rerun list in `C:\Users\elias\fable\tabx\docs.json`):**

- The 15 above.
- Ten random main-yardstick OCR documents with gold tables, drawn with seed 0 from the rest:
  95252bc13a1f, 9cc79b9e7a51, 163fa7d9cbdd, 68511d8caf27, c679effb768f, b8ae74f80062, 9b61decf2b9e,
  7b9a7de5665b, b7abc1fb4e54, 8c412481d385.

Every gold page of the 25 documents was run: 347 pages, 88 of them holding gold table rows,
959 gold rows and 2,525 gold cells.

**Models:**

- **TATR**: `microsoft/table-transformer-detection` on the page rendered at 150 dpi (longest side
  resized to 800). Then `microsoft/table-structure-recognition-v1.1-all` on each detection with
  score 0.5 or more, cropped with 20 px padding and resized to a longest side of 1000. Rows and
  columns are kept at 0.5 or more. Cells are row × column intersections, merged under spanning cells
  and projected row headers. The table extent is the detection box joined with its structure boxes.
  The v1.1 config needs `dilation: false` patched before it loads in transformers 5.19.
- **TableFormer**: docling-ibm-models 4.0.4, `accurate` weights, run with `do_matching=False` so it
  returns its predicted cell boxes. It ran on the same TATR detections, because docling's own layout
  detector was not installed.

**Projection:** each gold piece (word boxes of its span) goes to a table, then to a cell and to a
row. It is assigned to the box with the largest intersection, divided by the smaller of the two
areas, when that ratio is at least 0.5.

**Parser baseline:** tier-0 labels from rows-r8. Its cells come from the official grader on the
same documents (`score/fable/parser-r8-{dev,train}.json`, `table_cells` layer, span-exact). That is
a different matching rule from the one used here, so it is given for scale only.

### Page-level table detection (88 positive pages of 347)

| detector | recall | precision |
|---|---|---|
| parser tier 0 (any table row on page) | 18/88 (20.5%) | 18/21 (85.7%) |
| TATR ≥ 0.5 | 65/88 (73.9%) | 65/266 (24.4%) |
| TATR ≥ 0.7 | 47/88 (53.4%) | 47/169 (27.8%) |
| TATR ≥ 0.9 | 34/88 (38.6%) | 34/73 (46.6%) |

At 0.5, TATR flags 201 of the 259 pages that have no gold table. The lines inside those false boxes
are mostly gold `list_item` (2,279 lines), `text` (1,273) and `heading` (381). Typical cases are
lettered clause lists like "(a) … (b) …" in loan agreements and two-column name lists in the 1800s
monograph. Read as legal structure, these really are lists.

### Row and cell agreement (all 25 documents; TATR extent variant)

| system | gold rows inside a predicted table | row exact | cell exact |
|---|---|---|---|
| parser tier 0 (rows export; grader `table_cells` recall on same docs) | – | 1/755 (0.1%) | 91/3,268 (2.8%), grader rule |
| TATR ≥ 0.5 | 623/959 (65.0%) | 300/959 (31.3%) | **968/2,525 (38.3%)** |
| TATR ≥ 0.9 | 430/959 (44.8%) | 205/959 (21.4%) | 748/2,525 (29.6%) |
| TableFormer on TATR ≥ 0.5 detections | 520/959 (54.2%) | 240/959 (25.0%) | 872/2,525 (34.5%) |
| TATR structure on gold table extents (a perfect detector) | 849/959 (88.5%) | 374/959 (39.0%) | 1,119/2,525 (44.3%) |

The parser cell row uses the grader's own count: 73 + 18 cells correct out of 2,957 + 311 expected.

**By mode, TATR ≥ 0.5:**

| mode | cell exact | row exact |
|---|---|---|
| OCR | 800/2,208 (36.2%) | 252/772 (32.6%) |
| digital-born | 168/317 (53.0%) | 48/187 (25.7%) |

**With gold extents:**

| mode | cell exact |
|---|---|
| OCR | 894/2,208 (40.5%) |
| digital-born | 225/317 (71.0%) |

**When the table is found:** about 55% of the gold cells inside a detected table are exact, for
both TATR (968 of 1,767) and TableFormer (872 of 1,581). TATR misses (detection ≥ 0.5) break down
as 758 pieces outside any predicted cell, 594 cells merged with other text and 205 cells split.

**Per document**, the failures concentrate in two documents:

- 033c0d76209f is a 90°-rotated table in a scanned book. TATR labels it "table rotated", and the
  structure model was not given a rotated crop. It reaches 31 of 502 cells.
- 0a55ce238cae is a survey plan with small rotated legend tables. It reaches 4 of 163 cells.

Without those two documents, TATR gets 933 of 1,860 cells (50%) and the gold-extent run gets 1,080
of 1,860 (58%). The best documents are the label/value term sheets: 26d54f641967 at 86% of cells,
d5d56b4a36b1 at 71% and eab433e945b8 at 67%. Per-document lines come from `score2.py ... --per-doc`.

### Latency per page

| model | GPU (3080 Ti, 346 pages) | CPU (Ryzen 5 2600X, 6 threads, torch fp32, 39 pages) |
|---|---|---|
| TATR detection | 56 ms median | 576 ms median |
| TATR structure, per detected table | 61 ms median | 829 ms median |
| TATR, page total (mean / p90) | 124 / 200 ms | 1,479 / 2,292 ms |
| TableFormer, per table (median / mean) | 228 / 1,361 ms | 1,893 / 8,607 ms |
| TableFormer, page mean (plus TATR detection) | 1,497 ms | 8,100 ms |

- The CPU timing used the first 40 gold pages of eab433e945b8, a table-heavy contract; the warm-up
  page was dropped.
- TableFormer decodes autoregressively, so a large table costs seconds even on the GPU.
- The production laptop (i3-1315U) was not measured. These are desktop figures without ONNX export
  or quantization.

## Recommendation

Option (ii), with conditions. Option (iii) is ruled out by the census: digital pages without lines
account for 11% of the misses, and scans without lines for 70%. Option (i) leaves the parser at 20%
page recall and about 3% cell recall on these documents.

The model tier for scans should be TATR (detection plus structure-recognition v1.1-all) rather than
TableFormer:

- It matched or beat TableFormer on every measure: 38.3% vs 34.5% cells and 31.3% vs 25.0% rows.
- It costs about 1.5 s per table page on desktop CPU against 8.1 s.
- It reaches about 36% exact cells on OCR pages and about 50% outside the rotated and plan pages.
  The parser today gets about 3%.

TATR's detector cannot be the gate on its own. At the threshold that gives 74% recall, it calls 78%
of non-table pages tables, mostly clause and name lists. At 0.9 it still calls 15% of them tables
and its recall falls to 39%. So before wiring, the next measurement should pair TATR structure with
a better gate, for example the tier-0 tagger's table labels or a detection threshold combined with a
tagger vote, and score it on these 25 documents.

Two more things are needed:

- **Rotated crops.** Feed the structure model a rotated crop for "table rotated" detections. Those
  pages hold 665 of the 2,525 cells.
- **Grader fix.** Fix the grid convention for short lines in `grade/src/state.rs` before any
  `table_cells` score is used to judge this work.

Even with perfect table extents, TATR reaches only 44% of cells (58% without the two documents), so
the expected ceiling for this tier is roughly 40–55% cell agreement on scans.

## Rerun

Everything is in `C:\Users\elias\fable\` on the desktop; the venv is `C:\Users\elias\beaver-train\venv`.
docling-ibm-models 4.0.4 was added to that venv; no other package changed.

- `tab_census.py OUT.json` builds the census and the top-15 vector check; `tab_census2.py OUT.json`
  splits the misses by page vector status. Output: `tab_census.json`.
- `tabx\select_docs.py` writes `tabx\docs.json` (top 15 plus 10 random OCR documents, seed 0).
- `tabx\tatr_run.py docs.json OUT.jsonl cuda|cpu [MAXPAGES] [THREADS]` runs TATR and writes
  `tatr-gpu.jsonl` and `tatr-cpu6.jsonl`.
- `tabx\tf_run.py TATR.jsonl OUT.jsonl cuda|cpu [MAXPAGES] [THREADS]` runs TableFormer on the TATR
  detections and writes `tf-gpu.jsonl` and `tf-cpu6.jsonl`.
- `tabx\oracle_run.py docs.json oracle-gpu.jsonl cuda` runs TATR structure on gold table extents.
- `tabx\score2.py docs.json TATR.jsonl [TF.jsonl] [--extent] [--per-doc] [--index-cells]` scores the
  runs. Outputs: `score-base.txt`, `score-extent.txt`, `score-oracle.txt`.
- Helpers: `tabx\gold_cells.py` builds gold rows and cells with word boxes; `tabx\timing.py` gives
  latency; `tabx\fp_pages.py` lists TATR false-positive pages; `tabx\unit_shape.py` gives the shape
  of gold units; `tabx\grader_cells.py` gives the parser's grader `table_cells` on the 25 documents.

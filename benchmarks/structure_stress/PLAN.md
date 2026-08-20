# Structure stress sweep — every corpus, every structure claim

Goal: for any document our stack touches, we can say what its page /
paragraph / section / rules structure is — and prove it against oracles,
at corpus scale. This directory is the harness; summaries are committed,
raw per-doc results stay local.

## Corpora (inventoried 2026-07-29)

| Corpus | Where | Size | Docs | Oracle |
|---|---|---|---|---|
| A2AJ cases | `%LOCALAPPDATA%/ALR Quote Verifier/a2aj_corpus/cases/*/train.parquet` | 4.1 GB, 29 courts | 225,017 (EN+FR text) | `citation_en` (self-cite), `cases_cited_en[]` (curated cited list), bracketed-paragraph ladder |
| A2AJ laws | `.../a2aj_corpus/laws/*/train.parquet` | 701 MB, 12+12 sets | 23,531 (EN+FR) | `num_sections_*` + `unofficial_sections_*` (JSON label→text — section ground truth) |
| Journals | `.../data/public_endpoint-*.db` (`articles.text`) | 180 MB | 2,496 articles | `article_pages` (51,125 rows with page_label) + `page_map_json` |
| CanLII index | `.../data/canlii-*.db` | 316 MB | 3,538,714 case titles + 91,669 legislation titles | membership check for extracted cites; style-of-cause grammar vectors |
| docx_corpus | `benchmarks/docx_corpus/private_results` | — | 1,860 unique real footnote texts | behavior captures (predictions.*.jsonl) |
| CourtListener | `%LOCALAPPDATA%/OpenLegalProducts/LegalData/providers/courtlistener/courtlistener.sqlite` | local SQLite | 55,504 opinion bodies | native/hybrid/flat SourceDoc rows in the installed-provider freeze |

## Performance model (measured before building)

- duckdb parquet scan: 14.3 MB fetched in 0.2 s — I/O is not the bottleneck.
- Full grammar-table pattern set (22 entries at measure time), single core,
  real SCC text: **1.59 MB/s**. Slowest: statute entries (~10-16 MB/s each)
  with zero matches — fixed by literal prefilter gates (harness-side, tables
  stay pure).
- Projection: ~4.8 GB text × ~45 entries (after references/labels tables) ≈
  2 h single-core → **~12-15 min at 10 workers**, less with prefilters.
- Regex is the cost center → multiprocessing over documents; the main
  process streams rows from duckdb, workers run compiled patterns.

## What the sweep records per document

1. Grammar-table entries: match count per entry (prefilter-gated).
2. Shipping `legal-structure` paragraph/page blocks, spans, and abstentions.
3. Laws: shipping section labels and aliases scored against provider keys.
4. No harness-local structure detector: recovery uses the persistent
   SourceDoc JSONL bridge and the same shared Rust engine as production.
5. Journals: detected page-mark labels vs `page_map_json` label sequence.
6. Pathology: per-doc wall cap; docs exceeding it are recorded (catastrophic
   backtracking surfaces as slow docs) and skipped, never hung on.

## Tiers

- `smoke`: 150 cases/court (EN) + 50 FR, 100 laws/set, 100 journal articles —
  minutes; validates the machinery and baselines the summary shape.
- `dev`: 2,000 cases/court + all laws + all journals.
- `full`: everything, EN+FR.

Summaries per source land in `results/<tier>/<source>.summary.json`
(committed); failures capped at 2,000 rows/source in
`results/<tier>/<source>.failures.jsonl` (local only, gitignored).

## Early findings already banked

- Statute grammars (footnote lineage) scored **0 matches over 120 SCC
  judgments**: judgments write "R.S.C. 1985, c. C-46" with periods; the
  lineage grammar expects "RSC 1985". A dialect gap to quantify corpus-wide,
  not a bug to hand-patch — the judgment dialect belongs to Phase 4
  (legalTextAnchors' statute grammar) and any table entry for it must be
  extracted from that source, not invented.

## Out of scope here

The shared Rust structure engine and agreement-skeleton adapter sweep via the
persistent Node JSONL harness; this harness's
`--export-jsonl` gives it identical inputs. The ASCII-vs-Unicode `\w`
semantics comparison lives in the engine's `tools/grammar_differential.py`,
not here.

Historical reference-only detectors and one-off ladder/endnote/law probes were
retired after the 24-vector, hand-gold, statute, and installed-provider gates
made them non-authoritative; Git history retains their diagnostic provenance.

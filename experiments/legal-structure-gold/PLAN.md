# PDF structure gold generator

Produce a corrected manuscript and source-anchored structure from parser evidence
and full-page vision. The runner uses the PDF structure composer's roles and
annotation layers, with the parser/Text-Fidelity Codex transport and sparse edits.
Runtime agent assistance and [PageIndex reuse](../../docs/roadmap/pageindex-detection.md)
remain separate work.

## Run

```powershell
python experiments/legal-structure-gold/worker.py --pdf <pdf> --mode digitalborn
python experiments/legal-structure-gold/worker.py --pdf <pdf> --mode digitalborn --run --max-calls 12
python experiments/legal-structure-gold/worker.py --pdf <pdf> --mode ocr --run --max-calls 12
python experiments/legal-structure-gold/worker.py --corpus --limit 2000 --run
```

The default prepares compressed line evidence, prompts and `schema.json` without
calling a model. `--run` invokes Codex exec with Structured Outputs. Defaults are
gpt-6.1-sol/medium,
144 dpi, three bounded attempts and a 600-second timeout. `--max-calls` limits
new calls per PDF, including retries; cached responses consume no calls.
Execution is serial at Below Normal priority with one native/OCR worker.
Interruption terminates the process tree.

PDFs stay in the shared corpus. Generated runs and receipts belong in ignored
`benchmarks/local-data/legal-structure-gold/`. The installed native addon,
PyMuPDF, jsonschema and Codex CLI are reused; the runner does not build native code.

`--structure <json-or-json.gz>` accepts saved native structure or a full parser
export. `--extraction <json-or-json.gz>` supplies paired line evidence when needed.
Otherwise `extract.mjs` exports the installed parser's structure and native/OCR
witnesses from its cache, parsed with the app's own PDF profile
(`backend/src/lib/pdfProfile.ts`), which routes pages to OCR as the app does.
`--parser-request <json>` supplies other parser/OCR settings. Alignment requires
matching source IDs and glyph content.

A manifest has a `documents` array containing `path`, `mode`, and optionally
`sha256`, `pages`, `structure`, `extraction`, `parser_request`. Paths resolve against
`--root` or the manifest directory; CLI settings supply defaults. `--limit 0`
selects all rows; the default selects one.

`--corpus` freezes all saved PDF records into a private `corpus.json`, ordered by
page count then SHA256, with zero-page entries last. Existing harvest modes are
reused; other PDFs use the corpus classifier. The first 2,000 selected PDFs have
11,751 indexed pages. Completed records are verified and reused on restart.
A PDF that fails its parse or the reply contract keeps its failed receipt and is
retried on the next run; the batch continues. A provider failure stops the batch.

## Contract

`prompts.py` owns reading instructions; the shared `composer.py` owns the typed
correction schema and structural validation. Replies contain a `corrections`
array. Each record names one operation and contains its typed payload.
Operation variants constrain fields, enums and nullability. Schema shapes
follow the [supported Structured Outputs subset](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas).
Omitted decisions survive.

Each call edits one physical page with its immediate neighbours: r=1, at most
three images. All structural layers are checked in one serial pass. Compact
parent IDs and levels carry enclosing document/quotation scope without remote
text. Model input contains text, geometry, typography, blocks, annotations and
relationships. Font identities are compact IDs; empty metadata and redundant
whole-line extents are omitted. Provenance, filenames, point dimensions, native
proofs and parser diagnostics stay outside the prompt.

Digitalborn edits contain only incorrect characters; grouping, order and
annotations reuse source IDs. OCR can replace wrong whole lines. Both modes
recover genuinely missing printed lines with an insertion anchor and image box.
Splits retain adjacency and source geometry; explicit joins repair broken words.
Offsets in corrections count Unicode scalars; exported ranges use UTF-16.
Coordinates have a top-left origin with each page axis scaled to 0?1000.

| Layer | Gold records |
| --- | --- |
| Blocks | Paragraph membership, role, headings and numbering with levels, parents and markers |
| Tables | Complete grids, blanks, merged cells and header rows |
| Fields | Type, label, value, placeholder and checkbox state |
| Notes | Kind, printed label, body and referring markers |
| Quotations | Extent, layout, attribution and numbering scope |
| Documents | Printed type, start, parent, relationship, title and source facets |
| Continuity | Line joins, object continuations and document resumptions |

Layers overlap independently. Continued objects use page fragments and unique
anchors. Incoming links can be repaired at the target boundary without changing
context-page text. Each response validates the corrected prefix before caching;
future endpoints are checked when reached. Local checks enforce source coverage,
edit bounds, ownership, complete table grids, hierarchy and nonbranching links.
Contract failures receive bounded retries with the rejected response and error.
The complete document is validated before export.

## Products and checks

Completed runs contain `manuscript.txt`, `gold.json.gz`, `baseline.json.gz`,
compressed line evidence, the schema and call receipts. Gold includes structure layers,
source trace, physical/manuscript ranges, joins and replayable corrections.
Provenance records source/evidence hashes, parser/runner identities, run ID,
`machine_test`, model/effort and usage including failed attempts.

Page images exist only during the current r=1 call and are deleted in `finally`.
They can be rendered again from the canonical PDF, recorded renderer and DPI.
JSON is compact; bulk evidence, exact attempted prompts and provider logs are
gzip-compressed. Live runs retain one prompt copy per attempt.

The canonical corpus SQLite index owns the gold catalog. `gold_records` links
each dataset/source SHA256 to its status and selected run; `gold_runs` records
run provenance and receipt locators; `gold_artifacts` records product paths and
hashes. All selected corpus sources are registered before the limited batch starts.
Completed artifacts are registered after their receipt hashes are checked.

```powershell
python experiments/legal-structure-gold/evaluate.py --replay <completed-run>
python experiments/legal-structure-gold/evaluate.py --gold <gold.json.gz> --candidate <witness-output.json> --output <score.json>
```

Replay checks source identities and reproduces the entire gold and manuscript.
Comparison measures text, coverage, order, grouping, joins, roles, hierarchy,
each annotation layer, table cells, note references, document facets/ownership
and continuations. It reports counts, precision, recall and F1. Source-trace
alignment accounts for edits and splits. Candidates must use the same extraction;
independently segmented text needs an alignment adapter.

Offline public-corpus checks cover exact r=1 dispatch, differential manuscript
and structural results, partial fields, blank/merged cells, splits and geometry,
digital/OCR edits, scoped references, retry/cache behavior and identical replay.
Provider doubles exercise these contracts. Live image-reading accuracy and
provider usage are checked by retained digitalborn and OCR pilots: four pages,
four calls without retries, identical replay, no digitalborn text rewriting and
no retained rasters. Their receipts and products are registered in the catalog.

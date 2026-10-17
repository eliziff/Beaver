# PDF structure gold

The gold runner sees each page already extracted (native text or OCR), with its image. A lines
pass fixes the transcription and gives every printed line its region; a hierarchy pass then gives
each unit of the document its parent. One `legal-structure-gold.v4` file per source holds the
answer. The scorer measures a parser export against it. Runtime agent assistance and
[PageIndex reuse](../../docs/roadmap/pageindex-detection.md) remain separate work.

## Author

```powershell
python experiments/legal-structure-gold/author.py --pdf <pdf> --mode digitalborn|ocr [--out <dir>]
python experiments/legal-structure-gold/author.py --manifest <manifest.json> [--root <dir>] [--limit 0] [--shard k/n]
```

A manifest has `documents: [{path, mode}]`; paths resolve against `--root` or the manifest
directory. Defaults are gpt-6.1-sol/low, 144 dpi, three bounded attempts and four concurrent
calls per source. Output goes to `<out>/v4/<source-sha256>/` (`gold.json.gz`, `receipt.json`,
call receipts and page images); a complete receipt is reused on restart.
[Shared runner components](../../tools/codex_runner/README.md) own transport, accepted-response
caching, attempts and usage.

`extract.mjs` exports the installed parser's source lines with their extracted text, parsed
with the app's own PDF profile (`backend/src/lib/pdfProfile.ts`), which routes pages to OCR
as the app does.

The lines pass (`prompts.LINES`, three pages per call) types each page's lines in reading order
as `[region, text]`: text, list_item, heading, quote, note, table (cells joined by ` | `),
contents, caption, headnote, marginal_note, furniture or page_label. A tab follows each leading
printed marker (two for `12 (1)`), `[^N]` marks a note reference, and per page the reply gives
the lines that start a unit and whether the page continues the unit before. `blocks.py` aligns the typed lines to the extracted ones: each typed line's
source spans, cells, markers and references over the corrected text, and OCR text edits where the
typing differs (digital-born differences are reported, not applied).

The notes pass (`prompts.NOTES`, three pages per call, with an index of where every note begins)
pairs every note reference with its note's first line; an answer naming any other line is asked
again.

`hierarchy.py` groups typed lines into units (a start and the lines continuing it, across a page
the page continues) and asks, a page window at a time, for each ranked unit's parent and, where
the file holds several documents, the units that start and end each one; furniture, page labels,
marginal notes, notes and contents stay out of the outline.

A v4 file holds `lines` [{id, page, text (extracted), corrected?}], `typed` [{page, region, text,
start, continues, spans, markers, references, cells?}], `units` [{lines, parent, starts_document,
ends_document}], `notes` [{line, marker, reference, note}],
`text_edits` and a `report` of unanchored, unplaced and kept text.

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
the outline. v4 lines carry no geometry, so their reading position stands for it.

Layers: text, coverage, order, roles, groups and joins (adjacent pieces of one logical block),
continuations (kind, no separator), hierarchy (unit, role, relation to the unit before, parent,
marker, and each field alone), notes (extent, label), note references, tables (extent, rows,
columns) and cells, document starts and document ownership. v4 records no quotation
annotations, reading streams, fields, resumptions, note kinds, separators, table headers or
merges, document kinds, relationships or facets, so those are not scored. Source-trace alignment
keeps exact coordinates for shared extraction lines and projects page-local Unicode spans for
different extractions, reporting coverage and split/merge counts apart from the scores.

## Records

`worker.py` is the records runner's home: the canonical `legal-gold-package.v2` package per
source, its record owners and the scoped annotation publisher.

```powershell
python experiments/legal-structure-gold/worker.py --record-run <current-run> --record-selection <selection.json> --run
python experiments/legal-structure-gold/worker.py --enrich-run <canonical-run> <another-run>
python experiments/legal-structure-gold/worker.py --import-records
python experiments/legal-structure-gold/evaluate.py --replay <current-run>
python experiments/legal-structure-gold/evaluate.py --export <gold.json.gz> --record-id <id> --output <record.json>
python benchmarks/court-record-exhibits/score.py records <predictions.json>
```

`record_pass.py` adds document classification and selected standard information through the
shared call lifecycle. Its selection binds existing corpus PDFs, record page mappings and
source/proceeding/family/template separation from the frozen holdout. Each derivative document
is annotated within its explicit page scope. Classification coverage is recorded separately from
partial field coverage. Typed JSON values pass through a validated JSON-string response envelope.
Precise field evidence uses source-qualified Unicode spans in the package's shared text; the
model's exact printed-text cross-check stays in the call response. Page-only evidence remains
page-only.

The corpus SQLite index owns the catalogue: `gold_records` links each dataset/source SHA256 to
its selected run, `gold_runs` and `gold_artifacts` record provenance and product hashes. A pass
starts from the selected gold, declares the paths it owns, preserves other layers and binds its
receipt to the input source, text and gold hash; publication rejects stale input, journals the
write and recovers it if interrupted. `--import-records` ports existing record facts and
source/split recipes into one current owner per source; PDFs without text annotations keep page
geometry and record layers only. `--enrich-run` refreshes record/form annotations and their
source anchors. Matching affidavit records are read from the existing court-record-exhibits home
(`--court-records` selects another); their source/split recipes stay in `views`.

`anchors.py` binds evidence to one source SHA and text identity. Quotes use unique literal
matches; normalized values additionally need a labelled field annotation whose value spans
cover the match. Ambiguous, absent or derived values keep page-only evidence. `record_score.py`
scores document type, form/role labels, segment extent, typed field values, value status and
field/row locations separately.

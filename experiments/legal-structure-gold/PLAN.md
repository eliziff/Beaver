# PDF structure gold

The gold runner sees each page already extracted (native text or OCR), with its image, in every
pass. A lines pass fixes the transcription and gives every printed line its region; a notes pass
pairs every note reference with its note; a hierarchy pass then gives each unit of the whole
document its parent and marks where each document of a multi-document file starts and ends. One `legal-structure-gold.v4` file per source holds the
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

The lines pass (`prompts.LINES`, three pages per call) gives each page's printed lines in reading
order as `[region, text]`, corrected against the image: text, list_item, heading, quote (a block
quotation), note, table (cells joined by ` | `), contents, caption, headnote, marginal_note,
furniture or page_label. A tab follows each leading printed marker and `[^mark]` writes a note
reference with its mark as printed (a note's own leading mark is its label, never a reference). Per page the reply numbers the lines that start a unit; any other
line continues the last unit of its kind on its page or the page before. `blocks.py` aligns the
typed lines to the extracted ones: each typed line's source spans, cells, markers and references
over the corrected text, and OCR text edits where the typing differs (digital-born differences are
reported, not applied; canonically equivalent characters are no edit).

The notes pass (`prompts.NOTES`, three pages per call, with an index of where every note begins)
pairs every note reference with its note's first line; an answer naming any other line is asked
again. A file without notes makes no notes calls.

`hierarchy.py` groups typed lines into units and asks for each ranked unit's parent and, where the
file holds several documents, the units that start and end each one. The whole document goes in
one call with every page image while it fits the model's context (gpt-6.1-sol: 500k tokens; a
letter page at 144 dpi costs about 2,400, so about 150 pages) and the codex command line (about
150 image paths); a longer document goes in windows that each fill those bounds, carrying the
still-open ancestors of the window before. Furniture, page
labels, marginal notes, notes and contents stay out of the outline.

A v4 file holds `lines` [{id, page, text (extracted), corrected?}], `typed` [{page, region, text,
start, spans, markers, references, cells?}], `units` [{lines, parent, starts_document,
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

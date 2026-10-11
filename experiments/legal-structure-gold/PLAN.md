# PDF structure gold generator

Produce a corrected manuscript and source-anchored structure from parser evidence
and full-page vision. The runner uses the PDF structure composer's roles and
annotation layers, with shared Codex execution and sparse edits.
Runtime agent assistance and [PageIndex reuse](../../docs/roadmap/pageindex-detection.md)
remain separate work.

## Run

```powershell
python experiments/legal-structure-gold/worker.py --pdf <pdf> --mode digitalborn
python experiments/legal-structure-gold/worker.py --pdf <pdf> --mode digitalborn --run --max-calls 12
python experiments/legal-structure-gold/worker.py --pdf <pdf> --mode ocr --run --max-calls 12
python experiments/legal-structure-gold/worker.py --pdf <pdf> --mode ocr --producer <runtime-config.json> --run
python experiments/legal-structure-gold/worker.py --corpus --limit 2000 --run
python experiments/legal-structure-gold/worker.py --record-run <current-run> --record-selection <selection.json> --run
```

The default prepares compressed line evidence, prompts and `schema.json` without
calling a model. `--run` invokes Codex exec with Structured Outputs. Defaults are
gpt-6.1-sol/medium,
144 dpi, three bounded attempts and a 600-second timeout. `--max-calls` limits
new calls per PDF, including retries; cached responses consume no calls.
Execution is serial at Below Normal priority with one native/OCR worker.
Interruption terminates the process tree.

[Shared runner components](../../tools/codex_runner/README.md) own CLI transport,
accepted-response caching, attempts, usage and retained call receipts. The page
and hierarchy tasks supply their existing prompts, schemas, validators and
distinct retry policies. Pagination and compaction callers use the same process
transport with their existing options. Prompt text, schema bytes, image ordering,
model defaults and cache identities remain unchanged by this consolidation.
Hierarchy calls now retain evidence under the source run's `hierarchy/` directory;
`--redo` bypasses accepted-response reuse while keeping prior attempt receipts.

`record_pass.py` adds document classification and selected standard information
through the same worker and call lifecycle. This is a new task prompt; the page,
OCR and hierarchy prompts remain unchanged. Its selection binds existing corpus
PDFs, record page mappings and source/proceeding/family/template separation from
the frozen holdout. Each derivative document is annotated within its explicit
page scope. Classification coverage is recorded separately from partial field
coverage. Typed JSON values pass through a validated JSON-string response envelope
without changing the existing field representation.

Precise field evidence uses source-qualified Unicode spans in the shared corrected
text. The model's exact printed-text cross-check stays in the call response;
Gold retains the spans and normalized value. Whole-table evidence anchors the
table value, while independently located rows keep their own spans. Page-only
evidence remains page-only. Each record's anchors bind its facts and source/split
mapping, so changing an owner record invalidates stale companion evidence.

PDFs stay in the shared corpus. Generated runs and receipts belong in ignored
`benchmarks/local-data/legal-structure-gold/`. The installed native addon,
PyMuPDF, jsonschema and Codex CLI are reused; the runner does not build native code.

`--structure <json-or-json.gz>` accepts saved native structure or a full parser
export. `--extraction <json-or-json.gz>` supplies paired line evidence when needed.
Otherwise `extract.mjs` exports the installed parser's structure and native/OCR
witnesses from its cache, parsed with the app's own PDF profile
(`backend/src/lib/pdfProfile.ts`), which routes pages to OCR as the app does.
`--parser-request <json>` supplies other parser/OCR settings. Paired structure and
extraction inputs must have matching source IDs and glyph content. Candidate
scoring also supports different extractions, with alignment diagnostics below.

A manifest has a `documents` array containing `path`, `mode`, and optionally
`sha256`, `pages`, `structure`, `extraction`, `parser_request`, `producer`. Paths resolve against
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
three images. The current authoring bundle checks structural layers together;
this is a baseline to measure, not a requirement that every annotation use one pass. Compact
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
compressed line evidence, the schema and call receipts. New `gold.json.gz` products
use `legal-gold-package.v2`: one corrected source-text table, sparse original
extraction witnesses, page geometry and independent source-anchored annotation layers.
Physical/manuscript ranges are derived; original witnesses shared by split lines
live once. The durable annotation product is the gold itself. New records do not
save historical graphs or a separate history representation. Baselines, line
evidence and accepted provider responses remain existing authoring records;
replay reads those responses directly without duplicating them in the gold.
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
New runs and packaged originals use the current package dataset. A failed or
unfinished enrichment keeps the previous completed gold selected. Explicit new
extraction/structure inputs bypass the source-only restart shortcut; complete
identical runs are verified and reused without replacing a different completed
selection. Producer artifacts are bound by the
loaded extraction hash as well as their manifest hash. The scorer honours the
catalogue's selected current gold rather than choosing a different answer by
filesystem timestamp. Older indexed representations remain originals during
format iteration.

## Pipeline alignment

The target is one current gold per canonical source, with several independently
annotated uses. Multiple records can reference the same PDF; association context
belongs to the record, while printed text and page images belong to the source.

| Use | Annotation owner and distinct answer | Current position |
| --- | --- | --- |
| OCR recognition | Corrected printed text, linked to original-page physical lines | Shared text and original pixels; both Kraken producer routes exercised |
| OCR segmentation and order | Baselines, line polygons, typed region polygons, membership and explicit physical orders | Rich PAGE inputs retain these; per-task coverage gates training targets |
| Legal structure | Blocks, numbering, tables, fields, notes, quotations, document boundaries and continuity | Source-anchored facts scored without regenerating expected graphs |
| Document classification and extraction | Document/component extents, kind labels and source-located standard values | Existing record annotations carried through; 52 of 665 records have explicit segments |
| Affidavit/exhibit association and chronology | Citation-to-document links, events and record context | Existing annotation and redaction workflow retained |
| Form kinds and legal authority | Dated observations linked to source, form identity and supporting authority | Existing corpus catalogue, 2,725 kinds and 3,877 observations at this audit |

The producer stage supplies proposals from `Kraken -> Codex` or
`Kraken -> PPDoc -> Codex`. Text correction, regioning and physical reading order
can be authored together. Other annotations can consume the corrected text and
original page evidence in focused passes. Distant exhibit matching and document
relations need their existing record/document context, not just an OCR page window.
Each pass owns its annotations; changing an annotation does not require redoing
unrelated text or geometry. Passes write into the same gold, not parallel gold
representations. A later text correction must revalidate affected anchors and
dependent annotations rather than silently leave stale offsets.

Shared facts use IDs/spans; normalized values retain their distinct meaning and
source evidence. Visual region labels, document kinds, legal roles and form
identities are separate ontologies. Classification is a fact, distinct from an
OCR region label; a legal field and its normalized extracted date are distinct
annotations even when they share the same printed span. Whole-line identity
links and unchanged text stay implicit. Required geometry and actual exceptions
remain explicit. Gold does not contain a saved parser graph or export history.

Confounder-redacted association inputs are derived views. Their original-page
maps and masks remain in the existing split recipes. Dates, addressees, contact
details, natural pagination and substantive identifiers stay in the underlying
gold and source. OCR targets always pair original pixels with the corresponding
printed text. Form/authority observations use the existing catalogue's source
hashes and dated locators; absent or unresolved authority is recorded without
inventing a mapping. This runner currently references existing observations;
new kinds and authority evidence are still authored through the catalogue owner.

Coverage is scoped to the task and its document/pages. A completed authoring run
does not establish complete annotation of every downstream task. Missing layers
are unannotated, and missing objects on partial pages are not negative examples.
Classification and standard-field coverage still need expansion through their
existing record workflow; packaging cannot create those answers. Arbitrary
PDF/form editing is a later consumer of these anchors and identities, not a
capability demonstrated by the current gold exports.

The record audit found 2,832 standard-information entries across 311 segments,
with page locators but no corrected-text spans in the original records. Of the
665 records, 58 reference multiple PDFs, giving 1,163 record/source memberships.
The importer now reads those memberships from existing source manifests. The
primary PDF owns the complete record; companion PDFs hold its owner SHA and
their own source-local evidence targets. Acquisition provenance does not establish
annotation provenance: missing legacy authoring/model identity remains unknown.

Measure joint versus focused passes on the same frozen sources and shared text,
against independent fixed gold. Compare transcription accuracy, geometric
alignment, region masks, exact and pairwise reading order, annotation precision/
recall by kind, extracted-value accuracy, cross-page relations, model calls,
tokens, retries and elapsed time. Also check whether later passes damage earlier
annotations. Hold model/effort, images, inputs and call budgets constant where
possible; report differences rather than assume a joint or staged strategy wins.
Use the shared execution components and existing evaluators for this experiment.
The hierarchy pass and explicit record/form enrichment use the same scoped
annotation publisher. A pass starts from selected gold, declares the paths it
owns, preserves other layers and binds its receipt to the input source, text and
gold hash. Publication rejects stale input and recovers interrupted writes.
Complete record import still replaces that record's answers; focused tasks can
own narrower annotation paths. Text changes require anchor revalidation. Fresh
full authoring starts from producer evidence and is distinct from enrichment.
Comparisons between joint and focused schedules remain to be measured.

Compare the present joint bundle with text/regions/order followed by focused
legal annotations, using the same initial evidence and independently fixed
answers. Run both schedules with each producer route on the frozen development
cohort before choosing a schedule for the untouched holdout. Record which stage
introduced each error and compare total cost as well as individual task quality.

Freeze source/proceeding/template families together before splitting train and
holdout. Reuse the corpus and affidavit ledger to balance Canadian jurisdiction,
legal area, document kind, language and scan difficulty. The general parser's
all-corpus selection is not the Canadian programme's diversity selection. The
existing twenty-source pilot covers nine provinces, Yukon and federal sources;
the remaining jurisdictions and more document families need representation in
the measured OCR cohort. A positive loader mask or successful compilation proves
consumer compatibility; held-out learning results establish training usefulness.

## Multipurpose gold

`package.py` removes the materialized graph, replay responses, repeated offsets,
default whole-line extents and duplicate line-order lists from the gold. It reconstructs
the physical text and manuscript exactly, including UTF-16 ranges, different physical
and logical order, printed hyphens and sparse logical edits. Parser documents and
their fields/tables remain separate from classification, extracted information,
chronology and exhibit association. Blank, absent, redacted and unresolved values
retain their existing representation. A missing annotation layer stays unannotated.
All annotation runs are automated; there is no human review queue or approval gate.

Gold records hold the fixed answers. A changed parser produces a candidate graph;
the evaluator normalizes its source-anchored facts and measures them against those
answers. Scoring canonical gold does not build a reference graph or read export
history. Graph generation cannot rewrite the expected labels. Different candidate
schemas need adapters that preserve annotation meanings, not regenerated gold.
Changing an independently recorded answer creates a gold revision.

Parser gold exports adapt those answers to the current consumer contract using
only the gold file. Unannotated native heuristics and old parser metadata are not
carried forward as answers. These exports are disposable views, not another gold
representation to archive. Their receipts record source/gold hashes, exporter code
hashes, date and output hash. Completed packages are reused without rewriting their
annotations. Candidate outputs are measured against the fixed gold directly.

Existing originals and the pilot's earlier history artifacts remain intact while
the format is being validated. This retention is temporary protection against data
loss during iteration, not a requirement on new records or their consumers. A real
correction to an answer is a gold revision; changing its representation is not.

Existing completed runs can be packaged; explicit enrichment imports current
complete record/form annotations and resolves their source evidence without
new model calls:

```powershell
python experiments/legal-structure-gold/worker.py --pack-run <completed-run> <another-run>
python experiments/legal-structure-gold/worker.py --enrich-run <canonical-run> <another-run>
python experiments/legal-structure-gold/worker.py --import-records
python experiments/legal-structure-gold/worker.py --correct-text-run <current-run> --text-edits <edits.json>
```

`--pack-run` factors original formats and is a validated no-op for canonical
packages. It preserves already selected structure Gold; an existing record-only
source can acquire its completed structure annotations. Saved hierarchy sidecars bound to the original Gold are folded
into the imported blocks and their source hash is retained. Use `--enrich-run` to
refresh record/form annotations.

`--import-records` ports existing record facts and source/split recipes into one
current owner per source. PDFs without text annotations retain physical page
geometry and record layers only. They do not acquire empty text, invented
structure or OCR targets. The existing corpus catalogue indexes record ownership
and companion membership; answers remain in Gold. Annotation availability controls
structure authoring, scoring and exports, so importing a record does not mark its
structure work complete.

`--correct-text-run` accepts a JSON object with `source_sha256`, `text_sha256`,
`edits` and optional source-review `evidence`. Each edit names `line_id`, Unicode
scalar `start`/`end`, exact `old` text and replacement `text`. It preserves the
extraction witness, remaps unambiguous spans and manuscript normalization, and
rejects changes crossing annotation boundaries or changing extracted-fact evidence.
Publication atomically journals the corrected Gold and manuscript. Its receipt
binds the dependent annotations that were revalidated; superseded stages remain
superseded. Original authoring artifacts stay unchanged.

Matching affidavit records are read from the existing court-record-exhibits home;
`--court-records` selects another existing home. Their source/split recipes stay in
`views`, preserving source hashes, page mappings and confounder redactions.
Dates, addressees, contact details, substantive identifiers and natural pagination
remain in the underlying transcription. OCR exports use the original source view;
they never pair its text with a redacted or reordered image.

`--enrich-run` resolves each source's currently selected canonical gold. Enrichment
and hierarchy publication replace `current/<source-sha>/gold.json.gz` in the
existing gold home and update the same `gold_records`, `gold_runs`, `gold_artifacts`
tables. The current stage receipt records ownership, code and input/output hashes;
it is execution evidence, not a saved prior gold representation. Original
authoring runs and earlier `packages/<source-sha>/<annotation-hash>/` products
remain intact during format iteration. Receipt-relative artifact locators reuse
the author's baseline, evidence and manuscript without copying them. Form
references point to the existing
`legal_form_observations` keys, dates and metadata hashes; authority/source
provenance continues to live in that catalogue. The scorer selects one package per source
instead of counting both its original run and its compact representation.

`anchors.py` binds evidence to one source SHA and corrected-text identity. Quotes
use unique literal matches, checking typography/case/whitespace variants before
accepting uniqueness. Normalized information and exhibit metadata additionally
require an existing labelled field annotation whose value spans cover the match;
the anchor retains that annotation ID and validates its current coverage. A value
appearing once elsewhere on the page is insufficient evidence of its semantic
field location. Normalized values remain separate in their annotation layer.
Ambiguous, absent, unsupported or derived values retain page-only evidence;
missing or conflicting page maps remain unresolved. No fuzzy date or value
inference supplies gold spans. Existing table-cell rectangles and source regions
remain available but do not yet disambiguate repeated values.

Source/split recipes map original and derived exhibit pages to physical pages in
the correct PDF. Companion annotations reference the primary record without
copying it. Affidavit export resolves the selected canonical owner through the
corpus membership index. Original record files bootstrap previously unimported
records. Both paths verify
record identity and source membership, and resolve companion target paths against
that owner. Refresh the owner and affected companions when record answers or
source mappings change. Local target paths, source identity,
page coverage and scalar bounds are validated during publication. Changed
record/form annotations must update existing source anchors together. Record-only
imports preserve their existing page locators without adding redundant empty anchors.

```powershell
python experiments/legal-structure-gold/evaluate.py --export <gold.json.gz> --view parser --output <parser.json.gz>
python experiments/legal-structure-gold/evaluate.py --export <gold.json.gz> --view manuscript --output <manuscript.txt>
python experiments/legal-structure-gold/evaluate.py --export <gold.json.gz> --view affidavit --record-id <id> --output <record.json>
python experiments/legal-structure-gold/evaluate.py --export <gold.json.gz> --view pagexml --output <export-directory>
python experiments/legal-structure-gold/evaluate.py --export <gold.json.gz> --view line-ocr --output <export-directory>
python experiments/legal-structure-gold/evaluate.py --export <gold.json.gz> --view ocr-all --output <export-directory>
```

OCR/page-XML exports render the hash-verified canonical PDF at 300 dpi by default.
Each page has a PNG, exact source-unit text, image/text hashes, physical page
identity, dimensions/rotation, renderer and export date. Rich PAGE XML preserves
baselines, line polygons, exact ontology region types, region polygons and order.
Older gold exports source-unit boxes with untyped wrappers and carries no
baseline/region supervision. Manifests reference text files
and hashes instead of copying transcriptions. `line-ocr` additionally exports
exact pixel crops and matching `.gt.txt` files, with source/page/unit identity and
crop/page hashes in `lines.jsonl`. Crop names include the full source hash to avoid
collisions in existing training tools that flatten input directories. Source SHA,
page dimensions/rotation, nonempty pixel boxes and single-line crop targets are
checked. Recognition text/crops require complete recognition coverage when a
physical OCR layer is present. PAGE can carry complete typed regions even when
baseline segmentation is partial. Combined segmentation training requires complete
baseline/polygon and region coverage. Region-order and line-order training use
separate eligibility flags; line order also requires line geometry and exact
preservation of the gold's global order in region-grouped XML. Other adapters can
use the original global order without changing gold. Export manifests bind the current gold facts; re-export removes
only stale targets owned by the previous manifest, after checking their hashes.
Use `ocr-all` to retain PAGE and crop targets together in one destination. Export
manifests distinguish annotated coverage from realizable training targets, with
separate counts, eligibility and exclusions for crops and baseline-based PAGE
recognition. An unavailable crop leaves other usable page targets intact. PAGE
segmentation/order eligibility requires the geometry actually emitted in pixels.
The maintained OLJ staging command accepts canonical export manifests and the
existing source-qualified partition groups. It emits separate crop recognition,
PAGE recognition, baseline, region, combined segmentation, line-order and
region-order lists from those eligibility flags. PAGE/image pairs use source-qualified
names; the PPDoc converter resolves the bound sibling image. Recognition crops
compile through the existing recognizer wrapper. The original OLJ input path
remains available.

## OCR investigation, 2026-10-10

The existing affidavit store contains 665 gold records over 586 primary PDFs, with 5,973
exhibits and 12,085 chronology events. Document segments occur in 52 records:
311 segments, 304 with standard information, spanning 140 document kinds. These
existing annotations remain the reference for classification, fields and
association. The structure-gold inventory examined here contains 986 sources;
445 are Canadian, comprising 1,029 pages and 39,280 source units. This inventory
is a dated snapshot; collection continues independently.

The source-anchor check validated all 665 source/split manifests and 96,415 mapped
output pages. Completed gold now covers 48 record/source memberships; conservative
enrichment produced 58 supported text anchors and 197 page-only targets. A newly
authored one-page record supplies 24 standard-information entries with 27 value
leaves: nine anchors supported by labelled field annotations and eighteen page-only
targets, with every normalized value preserved. Its ambiguous caption/body and
unsupported jurat/residence matches stay page-only. Actual companion exports
resolve through canonical owners or the original record store without duplicating
record data. Private evidence is in `ocr-investigation/anchors.json`; all twenty
frozen gold packages and 183 frozen page exports retained their hashes.

The OLJ reference contains 661 pages, 32,630 line polygons and baseline polylines,
32,554 nonempty line transcriptions, and 7,074 typed regions. Those annotations
came from the existing model and Codex postcorrection workflow, including the
PPDoc finetune; their directory names do not imply manual annotation. They show
the required capabilities, while their older ontology must not set today's gold
labels. The current OLJ ontology is owned by
`tools/ocr/layout_regioning/core/ppdoc_ontology_contract.py`. Its 27 region types
are distinct from document classifications and legal structure annotations.
The PPDoc `project_ppdoc_full` export profile currently excludes
`table_of_contents`; the older UnlimitedOCR profile also merges several types.
Such mappings belong to individual training exports, preserving the full gold.

Reuse the existing OLJ geometry alignment, postcorrection and training consumers.
Git history records the relevant fixes: `b5a7fe2c` verifies line text before
attaching geometry; `6b02d861` rejoins same-baseline native fragments while
protecting columns; `c989e0ac` handles a specific private-use star glyph while
preserving its original. Sequentially pairing final text with old boxes, or
globally deleting private-use characters, would discard those solutions.
Running the existing same-baseline assembly on the current pilot proposes 131
joins, reducing 2,038 source units to 1,907 candidate physical lines. This is a
diagnostic proposal, not a change to the gold. The broader Canadian inventory
also includes 25 units containing multiple text lines. Source units and physical
OCR lines therefore need explicit membership/spans where they differ.

The twenty-source, 61-page pilot was tested on the desktop GPU through the
existing Tailscale SSH alias and OLJ remote helpers. It includes 47 digitalborn
and 14 OCR pages. Source/proceeding/template groups retain the frozen 52-page
training pool and nine-page holdout. Every fifth sorted training group was
assigned to validation before fitting: 44 train, eight validation and nine test
pages, containing 1,626, 212 and 200 crop targets respectively. No test results
were used to tune either model or revise annotations.

| Task | Actual consumer result | Data still needed |
| --- | --- | --- |
| Recognition | Kraken compiled all 2,038 crops. One GPU epoch reduced held-out character error from 11.97% to 8.85%. | Verified physical-line grouping, visible-glyph transcription policy and rule/checkbox treatment. |
| Reading order | Five GPU epochs trained on 84,122 ordered pairs. Held-out pair accuracy was 77.73%; exact page order was 0/9. | Independent physical-line and region orders, including columns and notes. Current targets order source-unit wrappers. |
| Baseline/line segmentation | The default Kraken PAGE loader retained zero of 2,038 lines. Actual segmentation masks contained zero baseline pixels. | Real baseline polylines, line polygons and annotation coverage. |
| Region detection/segmentation | The existing PPDoc mapper classified all 2,038 wrappers as unmapped, producing zero region targets. | Corrected typed visual regions, boundaries, membership and coverage under the current ontology. |

All 61 PAGE files validate against the
[official 2019 PAGE schema](https://www.primaresearch.org/schema/PAGE/gts/pagecontent/2019-07-15/pagecontent.xsd).
Schema validity did not establish usable segmentation supervision. A retained
OLJ control produced 44 baseline targets with the same actual Kraken mask loader.
No segmentation model was fitted to the current zero-baseline targets: missing
annotations must not become negative supervision. Kraken's documented
[segmentation inputs](https://kraken.re/main/user_guide/training_segmentation.html)
and [recognition inputs](https://kraken.re/main/user_guide/training_recognition.html)
are different contracts.

Recognition used the retained CATMuS Print Small base, one fixed epoch, learning
rate 0.0001, batch size one, seed 41010, NFKD and Unicode whitespace normalization.
Validation character error changed from 24.31% to 20.17%; held-out word accuracy
changed from 79.43% to 87.21%. These are small diagnostic results, not evidence of
performance over the complete corpus. Underlines represented as underscore runs
account for 21.9% of validation characters and dominate its errors. Inspected
crops include both discrete underscores and continuous rules. Eleven training
characters use private-use encoding; inspected examples render as checkboxes.
Contact symbols inspected in held-out email crops match their gold and must stay.
Do not fix this by deleting punctuation, contacts, rules or arbitrary glyphs.

The order model's held-out mean normalized footrule was 0.2956. A simple y/x
geometry baseline yielded 0.3227 and two exact pages out of nine. The existing
OLJ reading-order benchmark was reused unchanged. The tested Kraken model uses
geometry and class features; its
[documented limitations](https://kraken.re/main/user_guide/training_reading_order.html)
include orders requiring visual information. Passing the trainer is therefore a
consumer check, not proof that its learned order is adequate.

The installed environment was Kraken 7.0.2, PyTorch 2.7.1 with CUDA 12.6, on an
RTX 3080 Ti. Its PAGE API accepts boxes, but its CLI predates the `--linetype`
option. Its raw-box Arrow loader also initializes normalization before assigning
transforms. A process-local correction allowed training and testing; installed
packages were unchanged. Reloading trained Safetensors hit shared LSTM storage,
so evaluation used the checkpoint generated by this run. PyTorch's documented
[checkpoint loading setting](https://docs.pytorch.org/docs/2.7/notes/serialization.html#environment-variables)
was confined to that trusted-checkpoint evaluation process. A supported consumer
version or a narrow upstream fix is required before routine unattended training.
The later consumer port adds guarded, version-specific fixes to the existing
recognizer wrapper for the Arrow transform initialization/normalization and
Safetensors RNN-storage issues. The retained Safetensors model loaded through
the installed loader after those fixes.

The maintained staging and PPDoc conversion commands accepted both current export
routes: 217 direct-Kraken recognition crops and 236 Kraken-plus-PPDoc crops;
their COCO outputs contain 56 and 96 regions respectively, with no skipped types
or order-validation failures. Source-qualified filenames, fixed partition groups
and copied images/targets prevent collisions and later export changes from
altering a staged input. The final full Kraken dataset-loader verification did
not complete because the desktop WSL environment stalled, including on basic
commands. An Ubuntu-only restart succeeded, but the final loader launch produced
no completion receipt before work was wrapped up. Its results are not counted as
verified compatibility. The final stager changes for copied targets and explicit
geometry eligibility were syntax-checked but not rerun after the WSL failure;
independent COCO polygon/order comparisons also remain unfinished. The final
launch failed before inspection with `Wsl/Service/CreateInstance/CreateVm/ERROR_TIMEOUT`.
Task-owned launches were stopped and transport archives/helpers removed; the
existing Windows jobs were preserved. No training or new accuracy measurements were run for
this port. Current evidence and recovery notes are in
`ocr-investigation/consumer-port/`.

### Two annotation producer paths

Support both `Kraken segmentation + recognition -> Codex` and
`Kraken segmentation + recognition -> PPDoc -> Codex`. Both end in the same
current-ontology gold. Kraken supplies physical lines and geometry; PPDoc, when
selected, supplies additional region proposals. Codex postcorrection checks the
page image and corrects transcription, membership, labels, grouping and order.
Corrected geometry must remain linked to its actual source or correction, rather
than being replaced by inferred boxes. Record the chosen route and model/code,
image, prompt and ontology hashes once, with sparse per-object exceptions.

OLJ is reference material for the solved PAGE geometry and postcorrection paths.
Its original MLLM production runner is outside this work. The existing legal gold
runner invokes installed producers through `--producer <runtime-config.json>` or
consumes saved artifacts through `--extraction`, retaining baselines,
line polygons and typed regions alongside the shared corrected text. It uses
the same bounded Codex authoring call for legal and OCR annotations as the current
joint baseline; this does not determine the best grouping of later annotation passes.

Producer runtime configuration selects `layout_source: kraken|ppdoc`, the existing
`olj_root`, `ssh_host`, `remote_root`, `wsl_root`, DPI and timeout. `kraken` names
the installed executable, recognizer, segmenter, device and both model hashes;
`ppdoc` additionally names its executable, Python, model pack and model/manifest
hashes. `ontology` supplies the current owner, labels and source-file hash.
Optional `reuse` entries map source SHA and route to a manifest hash and artifact
hashes. Paths and host settings stay in private runtime configuration. Preparation
can run producer inference without invoking Codex; `--run` enables Codex authoring.
Both routes validate source pixels, model/ontology identities and retained files
before reusing prepared evidence.

For PAGE input, the extraction JSON declares `source_sha256`, `ocr.ontology`
(`owner`, source-file `sha256`, exact `labels`), `ocr.producer` (`layout_source`:
`kraken` or `ppdoc`, plus model/code provenance), and ordered `pages`. Each page
declares `page`, `pagexml`, `image`, and `dpi`; PPDoc pages also declare
`ppdoc_postprocessed`. Artifact paths are relative to the extraction JSON.
The original PDF, rendered pixels and PAGE dimensions must agree. PAGE line-level
TextEquiv is used; word-level transcripts cannot substitute for it. A PAGE input
provides its own source IDs and UTF-16 text baseline, so no fresh native parse is
needed. Existing native structure/extraction jobs continue through their usual path.

The canonical `layers.ocr` contains physical lines with baselines/boundaries,
typed region polygons with line membership, per-task page coverage and compact
producer/ontology provenance. Physical text refers to the existing line table;
identity membership is implicit. Legal fields mark spans in the same text. Legal
splits retain their original physical line geometry through member references.
Array order is the explicit OCR line/region order, independent of manuscript joins.
Corrected geometry and region replacements are sparse model responses.

The canonical gold adds the distinct answers needed: physical OCR line geometry
and exceptional source-unit membership/spans; typed visual regions with boundaries,
members and order; and per-page/layer annotation coverage. Recognition currently
uses the corrected shared text; a separate sparse visual-transcription override
is not implemented. Add such exceptions only when a source-backed difference
requires them. Reuse source text,
source IDs, page transforms and provenance. Identity mappings and unchanged text
stay implicit. Keep visual regions separate from legal blocks, fields, document
kinds and association views. A missing object on an incompletely annotated page
is not a negative example. Original-image OCR exports retain printed hyphens and
furniture; logical joining and confounder-redacted association views stay separate.

These annotations feed PAGE and line-crop exports for the existing Kraken and
PPDoc training consumers and the legal structure evaluator. Export manifests expose
`training_eligible` per task, `segmentation_training_eligible`,
`pagexml_region_order_eligible` and `pagexml_reading_order_eligible`. Consumers
must select the appropriate flag rather than treating PAGE presence as permission
to train every task. Incomplete segmentation does not suppress complete region or
order supervision. Recognition crops require complete recognition coverage.
Export profiles may select or map labels for a model without rewriting the gold. Changes to the actual ontology's
meaning require corrected annotations, not a new parser graph or saved export
history. The old originals remain retained during this format iteration.

Private evidence is in the existing ignored gold home's `ocr-investigation/`:
reference inventory, source and exporter hashes, frozen manifests, actual loader
and mask probes, crop pixel checks, commands, environment constraints, models and
training/test receipts. No new runner, corpus or human review queue was introduced;
the initial frozen-pilot assessment required no new authoring LLM calls. Subsequent
rich-OCR authoring runs exercised both producer routes through the existing runner.
The first two-page Kraken verification used three attempts, including one rejected text
edit, and its accepted responses replay identically. It retained 69 physical
lines and 35 typed regions. Recognition, regions and reading order are complete
on both pages; segmentation is partial on page one, so only page two is eligible
for combined segmentation training. Both pages now supply PAGE region/order data
and the 69 recognition crops.

The rich-input audit fixed a coordinate conversion that normalized PAGE source
boxes twice before the legal annotation prompt. Corrected evidence now agrees
with the physical OCR coordinates to floating-point precision. Original pixels
and printed contact details remain intact. Re-exporting checks previous artifact
hashes and removes stale owned segmentation/crop targets when eligibility changes.
Successful loading and compilation of these targets establish consumer
compatibility; held-out benefit from the rich annotations remains unmeasured.
The current remote check loaded page two's 31 baselines (33,122 positive mask
pixels) and all 18 typed regions. It retained exact line order and produced 930
line-order pairs and 306 region-order pairs. PAGE recognition compiled 31 rows;
the separate original-pixel crop export compiled all 69 rows with exact target
text. The independent-coverage consumer check also loaded page one's complete
regions and order despite partial segmentation: 272 region-order pairs and 1,406
line-order pairs, with exact region labels and line order. Page two retained 306
region-order pairs and 930 line-order pairs. Consumers must enforce each explicit
eligibility flag; this check does not establish held-out learning benefit.

The installed GPU trainers also completed one optimizer step for segmentation,
region order and baseline order, with finite weights and finite nonzero Adam
moments saved in their checkpoints. Segmentation used the eligible page's 31
baselines and typed regions; the two order tasks used both pages. Logged training
losses were 0.458, 0.697 and 0.694 respectively. Checkpoint and Safetensors writes
succeeded. This verifies training execution, not generalization: validation reused
the training pages solely for this check. The installed segmentation CLI required
`--resize new`; its advertised `both` option failed in the installed implementation.
Commands and hashes are retained in
`ocr-investigation/integration-batch/optimizer-proof.json`.

The subsequent integration batch completed both producer routes on the same
three development sources: seven pages per route and nine authoring attempts
per route, with no failed documents. These cover correspondence, a French
affidavit and a territorial court form. Original-pixel PAGE and crop exports
were checked for both routes. Complete baseline order can now export even when
typed-region coverage is partial, provided every retained line has geometry and
region membership preserves the physical order. The installed remote loader
consumed such a page's 26 lines and 650 order pairs; segmentation and region-order
training remained disabled for that page. Final training exports resolve the
selected current Gold, one export directory per source.

The existing focused hierarchy pass changed none of the three joint outputs
(37 units altogether). It required no additional model calls; this small result
does not establish whether fully separate annotation passes outperform joint
authoring. A separate live hierarchy call on a longer document exercised scoped
publication and changed two of 87 parents. Cross-extractor comparisons also need
transcription-policy context: a form's 441 native underscore characters render
as continuous blank rules, which the existing OCR prompts exclude. Visual
inspection and the saved prompts support both OCR outputs' recognition coverage;
all 562 non-rule, non-whitespace characters are retained. The low raw native/OCR
alignment on that page is not a recognition-accuracy estimate. Source, image,
prompt and older pipeline evidence are bound in `integration-batch/glyph-audit.json`.

Record readers, fresh authoring and source-anchor refresh now resolve the same
selected owner, including its source/split mapping. Refreshing anchors therefore
preserves later record annotations. Active exhibit/chronology/association readers
use this resolution; explicit frozen evaluation remains available. The association
port restores both existing benchmark lanes, preserving their input text, numeric
arrays, proceeding groups and folds. Twenty-three renamed file locators map to
the same source pages and tensor columns; expected associations resolve from
current Gold. All 53 saved artifacts are active again and all 11,254 numeric arrays
remain identical. Fresh preparation uses the existing source ledger's documented
grouping. A format port does not require refitting these models or replacing their
saved input text. Private verification is in `ocr-investigation/record-consumers.json`.

The record import published all 665 existing records under 586 primary owners,
covering 1,079 source PDFs. Record-only Gold preserves existing facts and physical
page geometry without manufacturing text or OCR annotations. The 33 other PDFs
in the raw manifest count belong to two candidates with no Gold records.
`record-import.json` records the conversion; the independent current-reader and
original-preservation checks live in
`ocr-investigation/record-import-current-verification.json`. The older OLJ pages
remain reference material for the OCR pipeline.
All 665 current record/source/split triples match their preimport facts; all
1,995 original JSON files are unchanged. Current readers resolve every record
without reading those originals. The catalogue contains the exact 1,163 record/source
memberships, and all 1,099 attached form observations match its existing entries.

The separate structure import converted 891 older selected sources with exact
text, structure and annotation parity, preserving their original artifacts.
`structure-import.json` records the source census, unchanged canonical selections
and per-source verification. No parser/model calls or new benchmark scores were
needed for either import.

The hierarchy conversion check preserved all 188 saved parent changes in 60
original runs. Among 722 sidecars reporting no parent changes, one also corrects
nine block depths; those corrections validate. Imported hierarchy completion binds
the shared text and block facts, so subsequent runs recognize the work as complete.
Source inspection resolved four sidecars whose new case titles had been attached
to the preceding case: four parent changes and three associated depth changes.
Sparse corrections bind the original Gold, original sidecar and source-page
evidence. The originals remain intact; all four corrected packages now validate
and are selected. Current annotation validation checks
its own facts, source evidence and stage receipts; historical operation replay is
available by explicitly replaying the original authoring run.

The private twenty-source pilot covers 61 pages, digitalborn and OCR documents,
French and English, nine provinces, Yukon and federal proceedings. It combines
three existing affidavit records and eleven existing form observations.
The complete multipurpose packages fall from 2,005,051 to 709,956 JSON bytes
(64.59%) and from 324,772 to 159,718 gzip bytes (50.82%). The retained pilot history
adds 39,522 gzip bytes; including that archive, the reduction is 38.65%. New records
do not create this archive. These measure the representation, not all archival
inputs and rendered images on disk. All twenty have identical source-anchored
answers and evaluator scores when exported without history. Their gold, original
authoring runs and existing history files remain unchanged.
All 61 refreshed OCR page images and transcription files retain their original
hashes; the frozen split remains 52 training pages and nine holdout pages. Ten
focused tests were recorded in the earlier pilot receipt; no tests were added or
run for the subsequent pipeline audit. That audit reverified all twenty original
gold packages, twenty source runs and 183 frozen PNG/text/PAGE artifacts unchanged.
Nineteen original operation runs replay with current code; one historical run
requires its recorded composer version. Package replay reports annotation parity
and source-operation replay separately.

The twenty superseded v1 packages were subsequently moved to the secondary
archive volume after direct comparison of all 61 pages and 353 legal annotations,
record layers, line geometry, evidence spans and retained authoring operations.
Their files retain exact hashes and existing locators remain usable. Current Gold,
v2 pilot inputs and original authoring runs stayed in place. The private
`ocr-investigation/archive-port-verification.json` records paths and move checks.

Current alignment findings and actual consumer results are retained in
`ocr-investigation/pipeline-alignment.json`. Verification resolves receipt-relative
artifacts for already packaged parents. Reusing an older cached package leaves
the selected enriched gold intact. Shared source identities must survive scorer
alignment; cross-extractor matching remains limited by line segmentation and
different original-text coordinate systems and must be reported separately from
parser annotation errors.
The updated scorer preserves all 22 selected canonical self-comparisons at 1.0. An
existing foreign-extractor comparison resolves one split and one merged source,
with 97.44% reference-character coverage, 97.37% candidate-character coverage and
98.82% recognition accuracy. This does not validate every inferred span. All 22
parser exports preserve printed/manuscript text and recover exact recognition,
including a source with multiline legal units expanded into native line fragments.
Some role/continuation state is still lost when reconstructing a candidate from a
parser export; exact text does not imply a lossless graph roundtrip. Detailed
per-source evidence is in `ocr-investigation/integration-batch/scorer.json`.
`ocr-investigation/runner-refactor.json` records prompt/schema/config and saved
call parity for the shared execution refactor. The actual accepted-call cache
was replayed with original-page images, zero provider calls and unchanged gold
and receipt hashes. No new tests or model calls were used for this refactor.

Selection, per-source measurements and export manifests live in the ignored gold
home's `pilot/`. Keep one current export per source. Source/proceeding/template
groups are frozen together before assigning training and holdout pages.

```powershell
python experiments/legal-structure-gold/evaluate.py --replay <completed-run>
python experiments/legal-structure-gold/evaluate.py --gold <gold.json.gz> --candidate <witness-output.json> --output <score.json>
```

Replay checks source identities and reproduces the gold and manuscript from
existing authoring records. Exporting or scoring a gold record does not require
those records or replay capability.

The existing record benchmark also consumes current Gold:

```powershell
python benchmarks/court-record-exhibits/score.py records <predictions.json>
```

Predictions map record IDs to `{"document_segments": [...]}`. `record_score.py`
scores document type, explicit form/role labels, segment extent, typed field
values, explicit value status and field/row locations separately. It pairs
segments by unique ID or source-qualified extent; a shared ID does not excuse
a wrong extent. Only NFC and whitespace normalize field strings, preserving
dates, phones, punctuation, case, JSON types and ordered arrays. Nested row
locators are excluded from value comparison and scored as locations. Existing
source/split mappings qualify pages across PDFs; regions and cells stay in their
recorded units. Missing annotations and unmatched predictions remain unscored,
and ambiguous extents are never paired by their predicted labels or values.
Reports bind the supplied Gold, source and split with hashes. `--gold-root DIR`
selects an explicit frozen record directory instead.

Existing-data verification covers all 52 annotated records: 311 segments,
2,832 field values, 379 statuses and 3,429 field/row locations self-score exactly.
The new current record contributes 24 values and locations. Independently
invented in-memory perturbations also exercise changed date/phone digits, JSON
types, absent versus null values, wrong extents, companion page mapping, geometry
units and unannotated scope. None of the 52 segment-bearing originals is
multi-PDF, so the companion scorer check uses invented data. Whole-field value
comparison gives no partial credit within a table; this is not an exhaustive
document detector benchmark. Evidence is retained in
`ocr-investigation/record-score.json`.

Comparison measures text, coverage, order, grouping, joins, roles, hierarchy,
each annotation layer, table cells, note references, document facets/ownership
and continuations. It reports counts, precision, recall and F1. Source-trace
alignment retains exact coordinates for shared witnesses and projects page-local
Unicode spans for different extractions, including split and merged witnesses.
Unmatched text remains candidate-local. Reports separate source/character
coverage, split/merge counts and inferred changed-length spans from annotation
scores. Repeated text and changed-length corrections still make foreign alignment
heuristic; controlled parser comparisons should reuse extraction where possible.
Parser exports are consumer views and do not reconstruct every internal authoring
state losslessly. A native product's
furniture is scored as furniture: lines no node owns in a page's outer bands, and
the page's folio line.

```powershell
python experiments/legal-structure-gold/score_all.py
python experiments/legal-structure-gold/score_all.py --against <earlier-summary.json>
```

`score_all.py` parses every completed gold PDF again with the most recently built
addon and the request its gold was made from, then micro-averages each layer into
`score/latest.json`. Copy that summary aside before a parser change; `--against`
reports the change over the runs both summaries scored.

Offline public-corpus checks cover exact r=1 dispatch, differential manuscript
and structural results, partial fields, blank/merged cells, splits and geometry,
digital/OCR edits, scoped references, retry/cache behavior and identical replay.
Provider doubles exercise these contracts. Live image-reading accuracy and
provider usage are checked by retained digitalborn and OCR pilots: four pages,
four calls without retries, identical replay, no digitalborn text rewriting and
no retained rasters. Their receipts and products are registered in the catalog.

# Legal PDF parser and machine-silver master plan

## 1. Objective

Build machine-generated silver data for the 1,500-PDF public legal corpus and
use it to improve, distil, and benchmark a universal Legal PDF Parser across
two lanes:

1. digital-native or usable embedded-text PDFs; and
2. scanned, image-dominant, OCR, and mixed PDFs.

The target is not generic PDF-to-Markdown conversion. The parser must preserve
source text and geometry while deriving legal structure, including headings
and hierarchy, numbered provisions and lists, footnotes and endnotes,
reference-to-note pairing, note-to-proposition pairing, reading order, tables,
forms, figures/captions, page furniture, printed page labels, and stable exact
lookups.

The immediate priority is the digital-native lane. Its failures should first be
fixed mechanically from native PDF evidence without Luna inference. The OCR,
regioning, Luna-silver, and distillation work follows from the corrected native
contract rather than defining a competing document model.

Paragraph segmentation is part of that contract, but an inferred prose
paragraph is not thereby a numbered legal paragraph. Geometry-backed paragraph
boundaries are useful for reflow, chunking, retrieval, and training. Unless the
source/provider supplies a real paragraph marker that wins a document-wide
numbered-unit sequence, unnumbered prose is addressed by its printed/physical
page and text anchor, not advertised as `para N`.

## 2. Fixed decisions and constraints

- The Legal PDF Parser is the baseline PDF evidence extractor and current
  behavioral baseline. `SourceDoc` remains the canonical linear legal
  projection. Semantic structure inference will be factored into one shared,
  provider-neutral structure engine used by both rather than maintained in
  either adapter.
- The project creates machine silver. It does not require new human page
  annotation or manual ground-truth production.
- The existing 661 manually annotated journal pages remain a frozen regression
  and calibration surface. They are not the target distribution and will not
  be expanded into a new labeling project.
- The expected future corpus is not primarily law journals. Journals must not
  dictate the universal ontology.
- Footnotes and endnotes remain first-class legal structures across document
  types.
- Heading hierarchy continues to use the existing document-level heading
  grammar wherever deterministic native evidence is sufficient.
- Reuse Text-Fidelity's measured PAGE-XML/BLLA line-geometry paragraph-break
  primitive before designing a replacement. Treat its output as segmentation
  evidence, not legal numbering, and keep literal source lines unchanged.
- Citation, reference, pinpoint, provision, and footnote-label detection uses
  the existing single authored legal grammar corpus. New dialects are added
  there with provenance and vectors; no runtime grows a shadow regex set.
- Digital-native text and geometry are immutable source evidence. Structural
  repair must not silently rewrite them.
- Digital-native structure is presumed recoverable and orderable. Major gaps
  in glyph, line, paragraph, provision, heading, note, relation, or page streams
  are failures, not acceptable degradation.
- Every emitted object-ID stream starts at 1 and is consecutive through the
  document. Every semantic numbering stream must have an observed origin, a
  valid successor grammar, and an explicit restart scope. Ordinary footnote,
  endnote, end-reference, and physical-page streams default to 1, 2, 3; custom
  marks and non-decimal heading grammars are explicit alternatives.
- OCR text and geometry must be tied to visual/segmentation anchors. Neither a
  layout detector nor Luna may invent unbounded source boxes.
- Luna is a machine teacher and repair mechanism, not a replacement PDF parser.
- No metered API is run without explicit authorization.
- Long-running corpus jobs must report progress, resume safely, and preserve
  usable per-document partial results.
- Model claims are accepted only on this corpus and its downstream structure
  consumers, not from vendor/repository benchmark claims alone.
- Production code does not change during the current audit phase.

## 3. Corpus facts that govern the design

The accepted corpus contains:

- 1,500 PDFs from 84 sources;
- 750 digital-born and 750 non-digital documents;
- approximately 86 semantic kinds and 10 coarse document types;
- 111,542 pages in total;
- 24,779 digital-born pages and 86,763 non-digital pages;
- a median of 9.5 pages, a 95th percentile above 500 pages, and a maximum of
  1,517 pages.

The corpus includes forms, notices, pleadings, affidavits, witness statements,
briefs and submissions, judgments and orders, transcripts, exhibits,
contracts, procurement documents, municipal and zoning bylaws, rules,
statutory compilations, inquiry and commission records, historical law reports,
monographs, and treatises. Observed layouts include ordinary prose,
multi-column indexes, bilingual/parallel text, transcripts with line numbers,
dense tables and schedules, fillable/dynamic forms, rotated pages, historical
scans, long hierarchical instruments, and mixed native/image documents.

The nominal 750/750 document balance therefore cannot be used as a page-level
training weight. Source, kind, template, generation, length, and page-layout
families must remain visible in sampling and reporting.

## 4. Canonical document representation

Keep four distinct layers. Do not collapse them into a single flat detector
ontology.

### 4.1 Source anchors

- physical page and printed page label;
- native glyph/span/word/line IDs and bounding boxes for digital-native PDFs;
- segmentation component/word/line IDs and bounding boxes for OCR PDFs;
- exact source text, font/style, orientation, language evidence, and source
  hashes;
- explicit split, merge, suppression, or visually admitted-anchor operations.

Source anchors are the geometry and transcription authority.

### 4.2 Page-layout roles

The working draft must be tested against the digital-native audit before it is
frozen. Current candidates are:

- `body`;
- `heading`;
- `numbered_unit` for provisions, clauses, rules, articles, and numbered legal
  paragraphs that are neither headings nor ordinary list items;
- `list_item`;
- `note_body`;
- `table`;
- `figure`;
- `caption`;
- `form_field` or form group;
- `running_header`;
- `running_footer`;
- `page_number`;
- `marginalia` or side note;
- `toc_or_index_entry` if audit evidence shows that this is reliably separable
  as a page role;
- `other`/abstention.

Paragraph starts are normally edges between anchored lines inside a body flow,
not another page detector class. A paragraph grouping is derived from those
edges after headings, tables, notes, forms, columns, and furniture are fenced.

### 4.3 Semantic attributes

- heading kind: document title, part, division, section, subsection, schedule,
  appendix, unnumbered, run-in, or unresolved;
- numbered-unit kind and enumerator family;
- note kind: footnote, endnote, side note, reference apparatus, or unresolved;
- list kind and nesting family;
- form entity kind: label, value, choice, signature, instruction;
- language, orientation, flow/column, repeated furniture, continuation, and
  confidence;
- evidence and provider provenance.

Every inferred paragraph boundary records its evidence kind (explicit source
break, provider-native block, vertical gap, sentence-plus-indent, block-start
indent, short terminal line/restart, or teacher repair), confidence, and source
line pair. The internal paragraph object's one-based ID is an implementation
identity only; it is not a printed label or legal locator.

`byline`, `abstract`, and `block_quote` are not universal core detector classes.
If later consumers require them, they remain optional semantic attributes.
`vision_footnote` is not a semantic class: vision/model identity belongs in
provenance. `vertical_text` is orientation. Header/footer images and seals are
object type plus placement attributes.

### 4.4 Document relations

- reading-order/flow edges;
- containment and continuation;
- heading parent and section span;
- numbered-unit parent/sibling relations;
- note-reference span to note body;
- note-reference span to containing proposition;
- caption to table/figure;
- form label to value/choice/signature;
- TOC/index entry to target;
- bilingual/parallel alignment;
- table row, column, cell, header, and multi-page continuation relations.

Add `paragraph_break_before` between adjacent lines and paragraph-to-line
containment. Keep it separate from numbered-unit sibling/parent relations.

Reading order, heading hierarchy, note pairs, table structure, and form links
are relations. They are not page-region labels.

### 4.5 Existing SourceDoc sequence contract

These are not new rules invented for the PDF corpus. They preserve and extend
the existing SourceDoc spine/ladder contract: choose a document-wide sequence
rooted at its real origin, prefer continuity, recover a missing marker only
where surrounding sequence evidence demands it, refuse a competing late or
gapped ladder, and keep provider-native structure when it exists. The PDF path
must reuse this machinery instead of approximating it independently.

- Physical pages, internal paragraphs, sections, notes, tables, images, and
  other generated object IDs form complete one-based sequences with no gaps.
  These are internal identities. Only an observed and validated semantic
  enumerator may be exposed as a legal paragraph/provision/note label.
- A semantic sequence is inferred document-wide, never from an isolated token.
  Its first item, successor relation, allowed increment, nesting, continuation,
  and restart scope must be recorded.
- Footnotes, endnotes, and end references normally begin at 1 and advance by 1
  within their scope. Symbolic/custom marks are a separate observed grammar.
- Heading and numbered-unit streams may use decimal, Roman, alphabetic,
  multi-part, or instrument-specific grammars, but each promotion must be
  licensed by the surrounding sequence and hierarchy.
- A decimal stream can be structurally valid without being a heading stream.
  For example, document paragraphs 1 through 513, form questions 1 through 9,
  and footnotes 1 through 970 are three different streams even when their
  tokens overlap on a page.
- Printed-page labels must form a coherent document sequence; front-matter
  Roman numerals, prefixed labels, and explicit restarts are modeled as grammar
  transitions rather than gaps.
- Any genuine exception—such as an intentionally omitted number, an excerpt,
  or a custom mark—requires direct source evidence and an explicit diagnostic.
  It is never silently normalized into a complete stream.
- OCR may abstain where source evidence is genuinely unrecoverable, but every
  gap remains explicit. The digital-native lane does not receive that
  concession merely because the current extraction/order strategy failed.

## 5. Overall architecture

### 5.1 One shared structure engine

Factor semantic structure detection out of both SourceDoc provider compilers
and the Legal PDF Parser. There must be one canonical implementation, not two
ports kept nominally in sync.

The boundaries are:

1. **Provider adapters** fetch/decode a source and emit canonical text plus any
   provider-native labels, anchors, blocks, excluded ranges, and provenance.
   They do not grow provider-specific paragraph, heading, page, or note
   detectors.
2. **PDF evidence extraction** remains responsible for PDF recovery, glyphs,
   spans, lines, geometry, source reading-order proposals, repeated furniture,
   spatial regions, tables, images, and other intrinsically physical evidence.
   It does not make a separate final semantic spine.
3. **The shared structure engine** reconciles native claims and inferred
   candidates into document-wide paragraphs, pages, headings, numbered units,
   sections, notes, references, propositions, hierarchy, continuation, and
   sequence state. Native provider structure is preferred; inference fills
   absent structure and validates conflicts.
4. **Projection assemblers** create `SourceDoc`, LegalDocument, and geometry
   views from the same structure result. `createSourceDoc` owns immutable text,
   blocks, indexes, locator ranges, and lookups; it does not detect structure.

The neutral engine input must support ordered text spans/lines, optional page
geometry and style evidence, native structure claims with origin/confidence,
explicit paragraph-break claims, and excluded ranges. Text-only providers need not manufacture PDF
geometry; PDF callers retain exact line/span/box anchors. Its output must carry
stable source references, origin, confidence, diagnostics, sequence grammar,
and unresolved conflicts.

Packaging is an implementation decision, not permission to duplicate logic.
Because the Legal PDF Parser is Rust and SourceDoc currently lives in
TypeScript, qualify either:

- a dependency-light shared library with bindings suitable for both hosts; or
- one versioned engine executable with a persistent JSONL/IPC protocol, linked
  directly into the PDF parser where appropriate and shipped as a sidecar for
  SourceDoc/provider compilation.

Choose between them using cold/warm latency, 1,500-PDF throughput, existing
large-provider corpus throughput, deployment size, crash isolation, and exact
output parity. A per-document process spawn and separately maintained Rust and
TypeScript implementations are both disallowed.

Rust is the leading implementation candidate to measure, not a foregone
rewrite. A standalone Rust structure crate could be linked directly by Legal
PDF Parser and exposed to the TypeScript host through a persistent sidecar or
binding. Restrict that experiment to the computational structure core. Provider
fetching, source normalization, SourceDoc indexing/query, projection receipts,
and Beaver application policy stay in TypeScript unless separate measurements
show a real bottleneck. Require differential parity before replacing the
existing measured SourceDoc selectors.

Current duplication to remove is already visible: Legal PDF Parser's
`structure.rs` derives regions, paragraphs, sections, notes, and proposition
links before serializing a finished SourceDoc-shaped result, while
`sourceDocA2AJ.ts` and `sourceDocNativeMarkup.ts` independently select
paragraph/page/section spines and merge provider-native blocks. The shared
engine is the convergence point between evidence extraction and projection
assembly.

#### Existing paragraph-boundary primitive to transfer

Text-Fidelity already implemented the required low-level primitive in three
connected places:

- `final_contract_galley.py` attaches PAGE XML line boxes by validated source
  order and infers browser reflow breaks;
- `postcorrection/paragraph_geometry.py` lifts the same measurements into
  reusable, findings-free telemetry; and
- `final_contract_v2/digitalborn_native_product.py::mark_structure_signals`
  emits `source_paragraph_break_before` from native line geometry.

The shared engine should port and generalize that implementation rather than
start from a region-per-paragraph assumption. Its proven body signals are:

- a vertical gap materially larger than page/flow-local typical leading;
- a sentence-ending flush line followed by a first-line indent;
- a first-line indent at the start of an already supported native block; and
- the narrowly guarded short-terminal-line restart used inside one block-quote
  region.

Preserve its important guards: operate only on eligible body lines; calibrate
per page and flow/family; skip column jumps; exclude headings, notes, TOCs,
tables, visuals, formula/algorithm regions, and other specialized structures;
suppress breaks across soft-hyphen or other must-follow continuity edges; and
prefer an explicit provider/source break. Wrongly attached geometry is worse
than absent geometry, so line-box attachment must be verified against source
identity/text rather than positional coincidence alone.

Do not apply the body model to footnote or endnote lines. Text-Fidelity's tests
show why: hanging note indents invert the body geometry and fire inside a note
while missing the next note label. Note paragraphs and note bodies continue to
use the note apparatus, label grammar, pairing, and continuation logic.

The canonical result is an anchored break edge and derived prose-paragraph
group, with source text/order untouched. It may drive reflow and chunking but
must not create a numbered-unit marker. A real printed/provider paragraph
number remains a separate numbered-unit claim selected by the document-wide
sequence engine.

### 5.2 One authored grammar substrate

The shared structure engine must consume the existing portable corpus at
`packages/legal-grammar-tables/grammar-corpus.json`, not copy its patterns.
It currently contains 64 citation, footnote-label, pinpoint, provision, and
reference entries with 252 frozen vectors, and the Legal PDF Parser's packaged
copy is byte-identical. Rust already loads the corpus for deterministic
citation splitting; TypeScript already uses the provision table in the legal
reference/skeleton path. Extend those real consumers rather than creating
another grammar layer.

Typed grammar matches become evidence for structure inference:

- citation and pinpoint spans are protected from promotion as page, paragraph,
  heading, table, or footnote ordinals;
- provision matches propose numbered-unit families and internal/external
  reference relations;
- footnote-label and note-reference matches propose note streams but do not
  establish one without sequence, typography, geometry, and apparatus evidence;
- reference/signal matches inform citation-part and note-cross-reference
  relations;
- every match preserves exact source offsets and the grammar entry ID.

Keep citation identity/resolution distinct from document structure: the shared
engine finds and types spans and relations, while provider lookup, alias graphs,
TOA grouping, and URL resolution remain their existing services.

Use Eyecite and other mature grammars as provenance-bearing source/oracle
material where corpus audit shows a missing dialect, especially for U.S.
reporters and statutes. The existing Eyecite decision still applies: do not add
Eyecite, `eyecite-ts`, or `reporters-db` as a runtime dependency and do not
build a competing citation AST/resolver. Admit a grammar only with licence and
provenance recorded, positive/negative vectors, portable-runtime compilation,
corpus recall/precision evidence, and exact-span differential checks.

### 5.3 Digital-native lane

```text
PDF ingestion/recovery
  -> native glyph/span extraction
  -> PDF-specific line/flow/geometry and object evidence
  -> provider-neutral shared structure engine
  -> SourceDoc + LegalDocument/geometry projections
```

The first implementation work occurs here. Luna is not required for ordinary
native structure repair. Later, only explicitly unresolved visual/semantic
cases may enter the bounded Luna lane.

### 5.4 OCR and mixed lane

The intended high-quality Kraken configuration must be established before OCR
quality conclusions are drawn. The abandoned preliminary run is not evidence.

```text
PDF ingestion/recovery and page routing
  -> image normalization/orientation/dewarp
  -> high-recall line/component segmentation
  -> Kraken recognition
  -> region proposals and source-anchor reconciliation
  -> bounded Luna r=1 repair
  -> the same shared structure engine
  -> SourceDoc + LegalDocument/geometry projections
```

Segmentation precedes recognition. Page regioning is a later grouping and role
inference stage. Mixed PDFs preserve usable native pages and OCR only pages
that require it.

## 6. Phase 1: digital-native structure audit

### 6.1 Purpose

Manually compare actual source pages with complete parser artifacts and find
false positives, false negatives, wrong types, boundaries, order, and
relations for every structure family. Summary counters and diagnostics only
prioritize inspection; they are not findings.

### 6.2 Audit surface

Materialize the complete 750-document digital-born lane because native parsing
is cheap enough to make corpus-wide failure and structure inventories useful.
Use the deterministic 60-document digital-born portion of the representative
120-document sample as the first intensive manual-inspection stratum, then draw
rare-structure, diagnostic, source, kind, template, and apparent false-negative
queues from all 750 documents. The full representative sample contains 10,435
pages, 62 sources, 70 kinds, every coarse document type, all jurisdictions, and
lengths from 1 to 1,517 pages.

Run selected PDFs through the public `prepare` contract with no OCR and no
external layout provider. Preserve one content-addressed cache and one atomic
record per document. Record ingestion failures separately.

### 6.3 Evidence required per finding

- candidate ID, corpus path, source, kind, jurisdiction, and SHA-256;
- physical/printed page and rendered source page;
- source line/span IDs, text, fonts, flags, bounding boxes, and source order;
- relevant regions, paragraphs, sections, footnotes, tables, and images;
- note anchors, bodies, occurrences/restarts, propositions, confidence,
  provenance, and warnings;
- expected structure, actual structure, error class, confidence, severity, and
  earliest failing mechanical stage.

### 6.4 Error classes

- false positive;
- false negative;
- wrong type;
- wrong boundary;
- wrong order;
- wrong relation;
- duplicate;
- source-content loss;
- unsupported schema;
- correct abstention;
- incorrect abstention.

For sequence-bearing structures, also record missing origin, illegal jump,
duplicate ordinal, false restart, missed restart, stream collision, and valid
sequence assigned to the wrong structural family.

### 6.5 Structure coverage matrix

For every row, inspect emitted structures for false positives and source pages
for false negatives:

| Structure family | Principal confusions to inspect |
| --- | --- |
| Native glyphs/spans/lines | hidden/duplicate/decorative text, clipping, ligatures, superscripts, rotated text, annotations, form values |
| Reading order and flows | columns, marginalia, bilingual text, forms, overlays, cross-page continuation |
| Headers/footers | repeated furniture retained as body; edge body removed as furniture |
| Printed page labels | paragraph numbers/dates mistaken for labels; Roman/prefixed/restarted labels missed |
| Prose paragraphs | one-line fragmentation; page/region-wide merging; first-line-indent and vertical-gap boundaries; headings/lists/tables/notes merged into prose; cross-page continuation; geometric groups falsely exposed as numbered legal paragraphs |
| Headings | numbered paragraphs/forms/tables/furniture promoted; typographic/run-in/unnumbered headings missed |
| Heading hierarchy | incorrect families, levels, parents, section spans, schedules, appendices, divisions |
| Numbered provisions | clauses/rules/articles/paragraphs confused with headings, lists, notes, and page numbers |
| Lists | headings/provisions confused with lists; nested/hanging/definition lists missed |
| Footnote references | paragraph numbers, citations, dates, exhibits, and page numbers promoted; superscript/symbol/repeated anchors missed |
| Footnote bodies | bottom body/signatures/tables promoted; continued, multi-column, wrapped, separator-defined notes missed |
| Endnotes/reference apparatus | provisions or bibliographies promoted; endnote headings/pages/restart scopes missed |
| Note pairing | wrong occurrence/body/restart; deterministic pairs left unmatched |
| Proposition pairing | wrong sentence boundary/paragraph; proposition missing despite native anchor evidence |
| Tables | aligned prose/TOCs/signatures promoted; ruled/unruled/schedule/continuation tables missed |
| Figures/images | page backgrounds/logos/ornaments promoted; meaningful diagrams/maps/exhibits/signatures/seals missed |
| Captions | prose/source notes promoted; table/figure titles not linked |
| Forms | prose promoted; labels/values/checkboxes/signatures and relations missed or misordered |
| TOCs/indexes | ordinary lists promoted; entry hierarchy, targets, index columns, and links missed |
| Indented/quoted matter | ordinary legal indentation confused with quotation; meaningful indentation discarded |
| Transcripts | line numbers/speakers/timestamps promoted as headings/notes; speaker turns and line coordinates missed |
| Parallel/bilingual text | streams interleaved; language/parallel relations absent |
| Cross-page structure | unrelated units joined; paragraphs/notes/headings/lists/tables broken at page boundaries |

### 6.6 Inspection procedure

- Inspect every page in documents of 20 pages or fewer.
- In longer documents, inspect first/last pages, every major layout transition,
  every diagnostic/repair page, representative ordinary body pages, and both
  sides of cross-page structures.
- Inspect all occurrences of low-frequency structures such as tables, forms,
  TOCs, figures/captions, endnote sections, bilingual layouts, and transcripts.
- For high-frequency paragraphs, headings, provisions, and notes, inspect all
  occurrences in short documents and stratified occurrences plus every
  diagnostic in long documents.
- Build false-negative queues independently from parser diagnostics using
  native font, span, geometry, superscript, indentation, repeated-edge, ruling,
  and embedded-object evidence.

### 6.7 Mechanical stage attribution

Assign each failure to the earliest responsible stage:

1. PDF ingestion/recovery;
2. glyph/span extraction;
3. line formation/source order;
4. flow/column/furniture/page-label inference;
5. paragraph/list/provision grouping;
6. heading qualification/hierarchy grammar;
7. note anchor/body detection;
8. note pairing/proposition extraction;
9. table/image/form/TOC specialization;
10. cross-page reconciliation;
11. validation/confidence/diagnostics.

For paragraph errors, distinguish a line/flow-order failure from a boundary
inference failure and from the later error of assigning an inferred prose
group a legal enumerator or locator it does not possess.

### 6.8 Phase output and gate

Produce a coverage table containing documents/pages inspected, true structures
observed, false positives, false negatives, boundary/order/relation errors,
representative IDs, mechanical causes, schema gaps, proposed deterministic
repairs, and regression-test surfaces.

Do not change parser code until every structure family has direct inspection
evidence or is explicitly absent from the audit surface and the major failure
families have multiple cross-document examples.

## 7. Phase 2: digital-native mechanical repair

Order fixes by earliest failing stage and downstream leverage. Likely work
areas, subject to the audit rather than assumed in advance, are:

1. deterministic recovery/fallback for valid-but-malformed PDFs;
2. preservation and filtering of native glyph/span evidence;
3. extract the existing SourceDoc spine/ladder machinery behind the neutral
   structure-engine boundary and prove its current provider fixtures unchanged;
4. route Legal PDF Parser structure evidence through that same engine, removing
   the competing semantic derivation as each output reaches parity;
5. route typed matches from the authored legal grammar corpus into the shared
   structure evidence plane and delete handwritten shadows as their span
   differentials pass;
6. qualify missing citation dialects against the corpus, using Eyecite and
   other mature sources as oracles rather than new runtime dependencies;
7. transfer Text-Fidelity's geometry-backed paragraph-boundary primitive into
   the shared engine, preserving its fixtures and source-line differential;
8. multiple-flow reading order for columns, forms, and parallel text;
9. repeated furniture and printed-page-label reconciliation;
10. explicit numbered-unit representation separate from headings, lists, and
   unnumbered geometric prose paragraphs;
11. heading grammar improvements across parts/divisions/sections/schedules and
   run-in headings;
12. note-anchor candidate filtering against legal numbering, citations, lists,
   dates, and page labels;
13. footnote/endnote apparatus modes and restart scopes;
14. deterministic note and proposition relations;
15. table/form/TOC/transcript specializations;
16. document-level cross-page validation and calibrated abstention.

For each change:

- add the smallest durable contract test that proves the public outcome;
- add real corpus fixtures/receipts where licensing and repository rules allow;
- run corpus-scale output-fidelity comparison because these changes affect
  legal structure;
- preserve exact source IDs and text;
- report intended changes, unintended deltas, and newly resolved diagnostics.

The extraction gate must run both existing SourceDoc fixture/stress suites and
the frozen 748-document native PDF artifacts. Provider-native blocks, source
text, locator lookups, and accepted sequences must remain exact unless a
reviewed audit finding requires a change. The first refactor changes ownership,
not behavior; corpus-derived improvements land only after parity.

The grammar gate inventories every shipping grammar consumer, runs all 252
current vectors in each applicable runtime, fails on missing/extra entries or
bundle drift, and differentially compares match spans with any implementation
being displaced. New Eyecite-derived or other external patterns enter the same
gate; repository claims or raw regex-count increases are not acceptance.

## 8. Phase 3: establish the OCR baseline

This phase begins only after the intended large Kraken model/runtime is fixed
and hash-locked.

### 8.1 Validate OCR components separately

- page routing and native/OCR preservation;
- render DPI, orientation, crop, dewarp, and background handling;
- line/component segmentation coverage, precision, split/merge behavior, and
  reading order;
- Kraken transcription quality and confidence;
- historical print, modern scans, bilingual text, tables/forms, rotation,
  marginalia, faint text, bleed-through, and noisy backgrounds.

### 8.2 Segmentation strategy gate

Determine whether one line finder is sufficient. Compare:

- the compact current line finder;
- the intended high-quality Kraken/BLLA or equivalent learned segmenter;
- deterministic connected-component/whitespace proposals;
- a proposal union with an explicit reconciliation policy.

The decision metric is not only line IoU. Measure omitted visible content,
split/merge errors, source-anchor coverage, downstream order, heading/note
recovery, runtime, and memory on the representative corpus.

### 8.3 OCR output contract

Every text repair must reference source visual anchors. Permitted teacher
operations should include keep, retype, retag, reorder, split, merge,
suppress-artifact, and admit a pre-existing missing-content proposal. Luna may
not invent free-form bounding boxes.

BLLA line polygons/boxes feed the same paragraph-break evidence contract as
native PDF line geometry. BLLA does not decide that a paragraph is legally
numbered, and its region labels do not replace the shared stream selector.

## 9. Phase 4: regioning method and ontology qualification

### 9.1 Model roles

The working hypothesis is two size-scalable responsibilities, not a commitment
to four unrelated detectors:

- a general layout family for regions, columns, tables, figures, forms, and
  furniture;
- a legal structure family or head for headings, numbered units, note bodies,
  anchors, endnotes, and relations.

Each responsibility needs a large/high-quality and small/portable deployment
path sharing one output contract. The audit decides whether the legal component
should be a whole-page detector, a line/span classifier, a document graph
model, or a combination. Do not assume it is another page detector.

### 9.2 Candidate families

Start with locally supported PP-DocLayoutV3 large/small checkpoints because the
repository already contains training, distillation, Rust postprocessing,
OpenVINO, and consumer infrastructure. Compare a DocLayNet-trained
DocLayout-YOLO large/small family only as a bounded challenger. Select by actual
corpus downstream outcomes and runtime, not published mAP.

The existing legal25 journal checkpoint is bootstrap evidence only. It may
contribute note/heading proposals, but it is not the new universal legal
specialist or ontology.

### 9.3 Proposal fusion

- Detectors propose regions; source lines/components remain geometry truth.
- Project all proposals onto source anchors with preserved raw scores and model
  identity.
- Keep deterministic whitespace, column, repetition, ruling, indentation, and
  font evidence as an independent proposal source.
- Preserve disagreements for the teacher rather than prematurely forcing a
  label.
- Evaluate complete anchor coverage and downstream legal structure, not only
  object-detection AP.

### 9.4 Ontology freeze gate

Freeze the core roles, attributes, relations, collapse mappings, and unknown
policy only after:

- the digital-native audit;
- valid OCR/segmentation evidence;
- cross-corpus region proposal comparison;
- confirmation that forms, tables, endnotes, transcripts, TOCs/indexes,
  numbered provisions, and bilingual flows are expressible;
- confirmation that prose-paragraph break edges/groups are expressible without
  being exposed as numbered legal locators;
- confirmation that the schema can collapse cleanly for small student models.

## 10. Phase 5: Luna machine-silver generation

### 10.1 Teacher input

For each target page, provide:

- the page image;
- r=1 neighboring-page visual/text context;
- immutable source anchors and text;
- native font/style/span evidence or OCR/component confidence;
- raw and postprocessed general/legal model proposals;
- deterministic parser candidates and diagnostics;
- document metadata and relevant running numbering/heading/note state.

The page image is authoritative for visual content. OCR and detector outputs
are hints, not ground truth.

### 10.2 Teacher output

Use a strict structured contract containing:

- anchor-preserving transcription repairs where permitted;
- page-layout and semantic roles;
- reading flows/order;
- prose-paragraph boundaries/grouping, kept distinct from
  list/numbered-unit grouping;
- heading candidates and observed enumerators;
- note reference spans, note bodies, note kind, and pair candidates;
- table/figure/form/TOC objects and relations;
- uncertainty, abstentions, and evidence provenance.

The teacher must account for every supplied source anchor exactly once or emit
an explicit operation explaining the change.

### 10.3 Page and document passes

The Luna xHigh r=1 pass repairs local page structure. It is followed by a
document-wide reconciliation pass that enforces:

- repeated furniture;
- page-label sequences;
- heading and numbered-unit family continuity;
- section hierarchy and spans;
- footnote/endnote occurrence and restart scopes;
- TOC targets;
- cross-page paragraphs/lists/tables/notes;
- transcript and bilingual flows;
- acyclic order and valid relations.

Use deterministic reconciliation first. Escalate only unresolved
contradictions to an additional bounded Luna pass.

### 10.4 Silver states

- `candidate`: teacher output exists but invariants or confidence gates fail;
- `silver`: all required source-accounting and structural invariants pass;
- `low_confidence_silver`: retained for analysis or down-weighted training,
  never silently treated as authoritative;
- inherited `manual_gold`: only the existing frozen human surfaces.

Machine silver is never renamed human gold.

### 10.5 Admission invariants

- complete source-anchor accounting;
- complete one-based object streams and grammar-valid semantic sequences;
- no unexplained text loss or duplication;
- no invented IDs or unanchored boxes;
- native text unchanged unless an explicit permitted repair exists;
- relations reference existing anchors/objects;
- acyclic order and coherent flows;
- coherent heading/provision/note numbering;
- valid note/reference/proposition relations;
- deterministic source, parser, model, prompt, effort, runtime, and output
  hashes;
- resumable per-page/per-document completion state.

## 11. Phase 6: corpus-scale silver production

- Run deterministic parsing and proposal generation across all 1,500 PDFs.
- Run the authorized Luna teacher route across the intended full silver
  surface, preserving per-document partial results.
- Do not let long monographs dominate training. Preserve every page in the
  silver corpus but use source/kind/generation/layout-aware sampling weights
  for training.
- Record routing, token/runtime cost, retries, invariant failures, confidence,
  and model disagreement.
- Keep raw baseline, raw proposals, teacher output, reconciled silver, and
  diagnostics separately. Never overwrite evidence.

## 12. Phase 7: large/small distillation and runtime profiles

The final system must cover powerful GPUs and budget laptop CPUs with the same
document contract.

Target profiles:

| Profile | Intended execution |
| --- | --- |
| Silver maximum | large general + large legal evidence + Luna xHigh + document reconciliation |
| Product quality | large general/legal model path with deterministic parser and optional bounded repair |
| Balanced | one large or paired small path selected by measured consumer quality/runtime |
| Fast GPU | small models with large batches and shared preprocessing |
| Budget laptop | small quantized/OpenVINO models, deterministic evidence, bounded fallback/escalation |

The exact combination is a measured decision. Prefer a shared architecture,
ontology, preprocessing path, and output schema across sizes. Distil from the
large machine-silver teacher surface; do not create separate incompatible
products for each hardware tier.

Promotion metrics include:

- complete anchor coverage and abstention;
- native text/source fidelity;
- OCR CER/WER where inherited truth exists;
- line omission/split/merge and order;
- core and semantic role accuracy against frozen machine silver;
- heading detection, parent accuracy, hierarchy validity, and section spans;
- numbered-unit family and nesting accuracy;
- note body/reference/pair/proposition accuracy;
- table/form/caption/TOC relations;
- runtime, peak memory, artifact size, cold start, and pages/second;
- results stratified by source, kind, generation, jurisdiction, length, and
  layout family.

## 13. Phase 8: benchmark design

### 13.1 Machine-silver benchmark

- Freeze the Luna silver producer identity and all inputs.
- Split by entire document, source/template family, and acquisition source;
  never randomly by page.
- Prevent duplicated forms, editions, repeated inquiry templates, and volumes
  from crossing train/test boundaries.
- Report student-to-teacher fidelity and invariant violations explicitly as
  machine-silver metrics.

### 13.2 Existing human regression surfaces

Reuse the existing 661 journal pages and other already available manual truth
for regression only. They measure retained capabilities such as OCR, line
segmentation, region roles, and journal footnotes; they do not establish
universal-corpus accuracy and do not trigger new annotation work.

### 13.3 Consumer-level evaluation

Region mAP is insufficient. Measure the public Legal PDF Parser outputs:

- exact page/paragraph/section/provision/note lookup;
- prose-paragraph boundary and chunk retrieval without synthetic `para N`
  citation labels;
- correct text returned for each locator;
- heading tree and section spans;
- footnote/endnote pairs and proposition passages;
- table/form projections;
- stable source IDs, hashes, and coordinates;
- correct diagnostic/abstention behavior.

## 14. Experiment and artifact layout

Durable repository artifacts:

- this master plan, including the rolling evidence ledger and decisions;
- sampling/runner scripts under `experiments/` only;
- compact manifests and hash receipts that do not expose downloaded corpus
  contents;
- promoted production code/tests only after a phase gate passes.

Ignored/disposable artifacts:

- corpus PDFs and downloaded assets;
- rendered pages, caches, raw model output, API responses, and contact sheets;
- temporary requests and per-run diagnostics;
- managed runtimes and model downloads not explicitly approved for release.

## 15. Current state and evidence boundary

- Corpus metadata and a representative 120-document sampling design have been
  produced.
- A preliminary OCR run was stopped because the intended large Kraken model may
  not have been configured. All OCR-quality and OCR-derived structural
  observations from that run are excluded.
- Native-only materialization is complete for all 750 digital-born PDFs:
  748 documents and 24,707 pages produced parser artifacts. Summary counters
  are not yet treated as audit findings.
- Two CanadaBuys documents (an RFI and an RFP, totalling 72 pages) fail the
  current parser at PDF ingestion. These are confirmed pre-structure failures
  and must be inspected for deterministic recovery paths.
- The architecture audit confirms duplicated structure ownership. SourceDoc's
  A2AJ/native-markup compilers already implement native-first paragraph,
  provision, page, and gap-aware sequence recovery. Legal PDF Parser separately
  derives page roles, paragraphs, sections, notes, and proposition links, then
  emits a finished SourceDoc-shaped payload. The planned remedy is one shared
  structure engine, not another PDF-only sequence algorithm.
- The earlier grammar-convergence work is present and must be reused: one
  authored 64-entry/252-vector corpus now ships byte-identically to the Rust
  parser. Rust deterministic citation splitting consumes it, while TypeScript
  production currently consumes mainly the provision grammar. The structure
  engine still needs typed citation/reference/note matches wired into its
  candidate and collision logic.
- Earlier model/ontology recommendations were under-evidenced and are superseded
  by the phase gates in this plan.

### 15.1 Reproducible digital-native audit baseline

Status: **in progress**. The findings below come from direct comparison of
source-page renders, parser overlays, emitted artifacts, production code and
tests, and repository history. Parser counters are used only to find pages to
inspect; they are not treated as correctness counts.

- Attempted: 750 digital-born PDFs and 24,779 pages.
- Passed native ingestion: 748 PDFs and 24,707 pages.
- Failed before structure inference: two CanadaBuys PDFs, 72 pages total.
- Frozen parser SHA-256:
  `85be89d29d6cfde928eaac66a7834d26568bbca25b467fbccf6945b1bd3075b4`.
- The parser emitted 23,924 claimed footnotes across 326 documents. Manual
  inspection already establishes large false-positive clusters in forms,
  tables, transcripts, page labels, and numbered prose, so this number is not
  evidence of note recall.
- OCR evidence remains excluded until the intended large Kraken configuration
  is established and hash-locked.

### 15.2 Confirmed implementation facts governing the refactor

- `rust/src/structure.rs` currently classifies page roles and flows, builds
  regions, pairs footnotes, creates paragraphs and sections, attaches
  propositions/cross-references, and validates the result. The Rust projection
  then emits a finished SourceDoc-shaped payload; `legalPdfSourceDoc.ts`
  validates and projects it but does not reconcile structure.
- `sourceDocA2AJ.ts` independently detects paragraph, page, and provision
  spines. `sourceDocNativeMarkup.ts` independently parses provider structure,
  excludes provider-owned ranges, detects omissions, and merges native and
  inferred blocks. Both then call `createSourceDoc`.
- `build_paragraphs` in the Rust parser creates one semantic paragraph per
  body or heading region. A page-sized region therefore becomes one paragraph
  even when it visibly contains several paragraphs, subheadings, lists, or a
  table caption.
- `build_sections` selects every heading-classified paragraph and extends its
  section to the next heading. When a heading region includes prose or table
  cells, that entire mixed region becomes the heading paragraph and poisons the
  section span.
- The A2AJ selector already implements the required root-at-1,
  successor-only, gap-intolerant document sequence. Its comments record
  measurement over 224,972 A2AJ cases, and its fixtures exercise repeated
  starts, out-of-order ladders, joined headings, tail fragments, endnotes,
  numeric tables, provider footnote fences, and hybrid native/reconstructed
  spines. This behavior is an existing contract to extract and preserve.
- `statuteSpine.ts` and `sourceDocA2AJ.ts` are already documented divergent
  descendants of the same earlier statute-spine algorithm. The shared engine
  must remove this internal provider-path split as well as the PDF/provider
  split.
- The 2026-07-30 commit titled `Adopt one canonical legal structure engine`
  unified local-PDF consumers behind the PDF engine and SourceDoc projection;
  it did not create a detector shared by PDF, A2AJ, and native-markup inputs.
  The current plan is a deeper boundary correction, not a claim that the
  SourceDoc sequence solution never existed.
- The authored grammar corpus at
  `packages/legal-grammar-tables/grammar-corpus.json` contains 64 entries and
  252 vectors across citation, footnote-label, pinpoint, provision, and
  reference tables. Its Legal PDF Parser package copy is byte-identical. The
  old 16-versus-19 citation-table drift is repaired; the current gap is that
  structure inference does not yet consume all of these typed spans.

### 15.3 Manual source-page evidence ledger

This is a rolling planning ledger, not a separate results report. Each entry
records the observed failures that later repair tranches must explain and gate.

#### `1887a3a58fc1997c683bd75b` — closing submission, 159 pages

Inspected pages 7, 51, and 127.

- Page 7 footnotes 1 and 2 are correctly detected and paired, while the bold
  `CANADA'S PARTICIPATION...` heading remains body.
- Page 51 numbered prose paragraphs 191–194 are promoted to headings/sections
  even though they belong to a valid document-wide paragraph stream. Real
  footnotes on the same page are present.
- Page 127 repeats the failure for paragraphs 511–513 and also treats ordinary
  prose as a table. Local decimal tokens are winning over the intact paragraph
  ladder.

#### `7ffad547b13c05501d91f8c1` — nominal financial form, 12 pages

Inspected all pages.

- The document is actually family-law rules/material, demonstrating that
  corpus kind metadata is a sampling hint rather than ground truth.
- Substantive headings and numbered hierarchy remain body.
- An isolated digit `3` is promoted to a footnote without a coherent note
  apparatus.
- Numbered rule/provision streams are absent from the semantic projection.

#### `52c3516b037bd30495357ebd` — court form, 4 pages

Inspected all pages.

- Labels, values, questions, choices, instructions, and signature areas have
  no form relations.
- A table boundary is materially wrong.
- Question numbers are promoted as footnote references.
- The repeated form header is generally identified correctly.

#### `6c4b538ff521f85c76023738` — nominal transcript, 6 pages

Inspected all pages.

- The document is actually a letter/submission rather than a transcript.
- Headings remain body.
- Genuine notes are substantially detected and the page footer is correctly
  separated, giving a useful positive note/furniture control.

#### `9e1a9f412c72f2b0b73f4dff` — rules/regulations, 6 pages

Inspected all pages.

- Substantive section 440 headings and subheadings remain body; no useful
  section hierarchy is emitted.
- A `(1)` provision/list marker is promoted as a footnote reference.
- Numbered provisions and lists are not represented as distinct streams.

#### `04c9b9057313aa9f4e6497b4` — nominal statute compilation, 8 pages

Inspected pages 1–4 and 8.

- The document is actually a corporate submission.
- Roman and decimal headings remain body; no sections are emitted.
- Genuine footnote references and bodies are generally detected on pages 1,
  3, and 4.
- Page 8's `Page | 8` remains body and contaminates note-reference detection.
- Repeated letterhead/banner graphics produce 16 image objects although they
  are decorative furniture, not meaningful figures.

#### `0b1f9a2b92bc22c509da5dfe` — presentation, 17 pages

Inspected pages 1–3, 8, and 17.

- The title-page section is recognized.
- The TOC heading is recognized, but entries have no hierarchy, targets, or
  relations; TOC page numbers 7 and 8 become footnote references.
- Most substantive prompts and heading levels are missed; only two sections
  are emitted for 17 pages.
- The repeated House-of-Commons code is correctly a header and `Page x of 16`
  is a footer, but the printed-page relation is absent.

#### `d451fa836c772d87455eee42` — zoning map/index, 14 pages

Inspected pages 1–3 and 14 using corrected overlays.

- Page 1 is a meaningful zoning map but has no figure/map object.
- Pages 2–14 are four-column street-index tables. Table bounds cover the
  populated columns, including the final single-column remainder.
- The repeated `STREET NAME / MAP` table header is also classified as page
  header and section heading, creating thirteen false sections.
- Page numbers and the repeated date are correctly classified as footers.
- Index-entry hierarchy and target semantics are absent beyond the physical
  table.

#### `ea4ca61f2690c75fbaeca5c6` — research report, 53 pages

Inspected pages 1–4, 10, 20, 40, and 53.

- The cover title, `Executive Summary`, and major topical headings remain
  body.
- Ordinary prose pages commonly become one body region and therefore one
  emitted paragraph, merging visible paragraphs and subheadings.
- Page 10 recognizes a numbered heading and note references 6–8, but its
  heading paragraph/section absorbs prose, table content, and note-body lines.
- Page 20 detects the table, but splits its caption and lets table cells enter
  the section span.
- On page 40, table prices, providers, descriptions, and source text become
  footnote bodies while another small table is missed.
- Table-cell text is repeatedly promoted to sections. The repeated report
  banner is correctly treated as a header.

#### `49bc9ed1bc05ef7fd4c34624` — agreement/municipal report, 72 pages

Inspected pages 1–3, 10, 40, and 72.

- The opening TOC-like overview has dotted leaders, nesting, and printed
  targets but no TOC hierarchy or target relations.
- A bilingual running committee banner is detected as a table on almost every
  page, while the actual ruled multi-page agreement/description table is
  missed on pages 10, 40, and 72. Seventy emitted tables across 72 pages track
  the banner false positive rather than the substantive table.
- Bold and underlined internal headings remain body; no sections are emitted.
- The document emits 367 images; inspected examples are bullet glyphs,
  underlines, and fragments of heading text, not meaningful figures.
- Visible printed folios 135–206 are not reconciled into a printed-page
  sequence.

#### `057c19eb25ff56cec4a5d0ff` — U.S. Supreme Court transcript, 69 pages

Inspected pages 1–3, 10, 35, 68, and 69.

- The page-1 title is correctly recognized as a heading/section, but the
  reporting-company contact block at the foot of the page becomes several
  false footnote bodies.
- Transcript line numbers 1–25 are emitted as independent body
  regions/paragraphs. Speaker identities, speaker turns, and line-coordinate
  relations are absent.
- The contents page has a detected table but no TOC targets or relations.
- Page 10 contains a large false table over ordinary dialogue.
- A centered `ORAL ARGUMENT OF...` transition on page 35 is missed as a
  heading/speaker-transition structure.
- The pages 68–69 multi-column word index is not recovered as an index/table.
  Alphabetic index entries become headings/sections; page:line coordinates
  create false references and note references; the repeated reporting-company
  footer itself becomes a heading/section.

### 15.4 Established cross-cutting failure clusters

1. **A spatial region is standing in for a semantic paragraph.** Page-sized
   regions merge paragraphs, subheadings, lists, and captions.
2. **Numbered streams collide.** Paragraphs, provisions, form questions, line
   numbers, TOC targets, printed pages, table values, citations, and notes are
   promoted from local tokens before their document-wide streams are selected.
3. **Table evidence contaminates semantic structure.** Table cells become
   headings, sections, notes, or references; repeated banners become tables;
   some true ruled and multi-column tables are missed.
4. **Heading recall is narrow and heading boundaries are unsafe.** Titles,
   ordinary typographic subheads, provisions, Roman ladders, and run-in
   headings remain body, while mixed heading regions absorb prose/tables into
   section spans.
5. **Forms, TOCs/indexes, and transcripts need relations, not merely more
   region labels.** Their labels/values, targets, speakers/turns, and
   coordinates cannot be recovered from a flat body/table/note ontology.
6. **Image extraction overclaims decorative vectors and glyph fragments, while
   meaningful map/figure content can be absent.**
7. **Furniture and printed-page streams are inconsistently reconciled.** A
   repeated element can be correctly identified on ordinary pages and become
   a section, table, or body on specialized tail pages.
8. **Corpus metadata is not document truth.** Several inspected nominal kinds
   are wrong; layout and source evidence must determine routing.
9. **Paragraph segmentation and legal numbering are conflated by the current
   output shape.** A region-derived internal paragraph ID can be useful for
   indexing, but it must not imply that an unnumbered prose block is a
   source-addressable `para N`.

### 15.5 Remaining digital-native audit work before code changes

- inspect genuine bilingual/parallel layouts and their reading order;
- inspect endnote and reference-apparatus documents independently of parser
  note claims;
- inspect cross-page paragraphs, notes, tables, headings, and lists;
- compare native line geometry against Text-Fidelity's large-gap,
  sentence-indent, block-start-indent, and continuity guards on multiple
  non-journal document families;
- inspect meaningful figures, exhibits, signatures, seals, and captions;
- inspect printed-page grammar transitions and restarts;
- quantify each established cluster across independent documents and sources;
- complete false-positive and false-negative queues for every structure family
  in Section 6 before prioritizing production repair.

## 16. Immediate next actions

1. Finish mapping SourceDoc and Legal PDF Parser structure responsibilities,
   tests, corpus gates, and performance constraints into the shared-engine
   extraction boundary without changing production code.
2. Build a corpus-wide native structure/diagnostic inventory from the 748
   successful documents without treating counters as correctness evidence and
   without reimplementing SourceDoc's sequence selector in an experiment.
3. Continue page renders/overlays from the existing source and parser artifacts.
4. Manually audit false positives and false negatives across every structure
   family in Section 6.
5. Record examples, prevalence, mechanical causes, schema gaps, and resulting
   decisions directly in this master plan.
6. Specify the neutral evidence/result contract and choose library versus
   persistent sidecar packaging from measured integration constraints.
7. Inventory grammar consumers and map the existing authored corpus into the
   structure-evidence contract; identify measured dialect gaps before importing
   any Eyecite-derived grammar.
8. Freeze a Text-Fidelity paragraph-boundary transfer fixture and specify the
   separate prose-paragraph versus numbered-unit projection contract.
9. Prioritize deterministic fixes and regression surfaces.
10. Only then begin production code changes, beginning with behavior-preserving
   structure-engine extraction.
11. Re-establish the intended Kraken baseline separately before drawing OCR or
   scan-regioning conclusions.

## 17. Completion criteria

The overall effort is complete when:

- digital-native mechanics pass the corpus-scale structure audit and fidelity
  regression;
- every provider and PDF path uses the same structure engine, with no copied
  sequence/heading/note grammar and no provider integration inside the engine;
- every citation/reference/pinpoint/provision/note grammar consumer loads the
  authored corpus or a mechanically verified copy and passes cross-runtime
  vector and span gates;
- native and BLLA line geometry produce anchored prose-paragraph boundaries
  through the shared engine, while only source-validated enumerators become
  legal paragraph locators;
- the intended OCR/segmentation path is validated across the scan diversity;
- the layered ontology and model responsibilities are frozen from evidence;
- Luna machine silver exists with source accounting, provenance, and document
  consistency across the corpus;
- large and small students meet their quality/runtime profiles;
- source/template-held-out machine-silver benchmarks and inherited human
  regressions pass;
- no source text, geometry, deep legal relations, or exact lookup capability is
  traded away for speed.

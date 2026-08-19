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

## 18. Executable project contract and harness

### 18.1 Required project result

Deliver one provider-neutral legal structure engine that:

- is linked directly into Legal PDF Parser and used by every SourceDoc
  missing-structure recovery path without a second implementation;
- preserves provider-native paragraphs, pages, sections, footnotes/endnotes,
  anchors, and exclusions as authoritative claims unless a source-identity
  violation is diagnosed;
- uses the existing root-at-1, monotonic-successor, gap-intolerant structure
  selector for inferred numbered streams;
- retains and modestly improves the existing strong note pairing/repair and
  page detection rather than replacing them;
- derives unnumbered prose paragraph boundaries without inventing legal
  paragraph locators;
- materializes fast native results for all 750 digital-born PDFs and settled
  Kraken-lite results for all 750 non-digital PDFs; and
- runs on GPU and laptop profiles with the same source-accounting and semantic
  contract.

The project is not complete when only a new module exists. It is complete when
the old duplicated semantic detectors have been deleted, every provider/PDF
caller uses the shared engine, whole-corpus receipts pass, and the entire
root-plus-subrepository production source has contracted.

### 18.2 Frozen quantitative baseline and ceilings

Baseline root commit: `5d29906341d17239e5e36a5442ca665f5f2a12f0`.
The line receipt includes the root and every repository pinned by
`subrepos.lock.json`; moving code into a subrepo cannot improve the number.
Vendored third-party code and generated source are reported separately, while
all authored production, tests, experiments, and tooling remain visible.

| Metric | Baseline | Hard ceiling | Completion target |
| --- | ---: | ---: | ---: |
| Whole-project production nonblank lines | 125,896 | 125,896 | at most 124,500 |
| Whole-project production + test lines | 181,886 | 181,886 | at most 180,500 |
| Whole-project all authored code lines | 285,654 | 285,654 | at most 284,000 |
| Tracked compact receipts for this program | 0 | 5 MiB | under 2 MiB |
| One per-document receipt | n/a | 32 KiB | under 16 KiB median |
| One phase summary | n/a | 256 KiB | under 64 KiB |
| Legal PDF Parser binary | 16,616,960 B | 16,949,299 B (+2%) | no material growth |
| OCR cache excluding source PDFs/models | n/a | 10 GiB | smallest lossless reusable cache |

`npm run check:source-budget` is the fail-closed source gate. The configuration
and all performance/artifact budgets live in
`scripts/legal-structure-guardrails.json`. A vertical slice may temporarily
add code in a dirty worktree, but it cannot be accepted until its old path is
deleted and both whole-project ceilings pass.

The baseline is four lines higher than the counter's first draft because the
tracked `watch-qwen.cmd` was executable authored source but `.cmd` was not in
the old extension set. The guardrail was corrected rather than preserving a
convenient undercount. It is another 231 lines higher because the existing
clean `mike-workflows` repository was ignored and absent from the subrepo lock;
it is now pinned and counted. The completion targets were not raised.

### 18.3 Speed and build budgets

Slow feedback is a defect. Use cached extraction/OCR evidence and replay only
the structure layer during development.

| Gate | Required result |
| --- | ---: |
| Warm `cargo quick` median / p95 | at most 2.0 s / 4.0 s |
| Final incremental release link | at most 30 s |
| Inner-loop SourceDoc provider parity smoke | at most 1 s |
| Complete SourceDoc provider regression suite | at most 8 s |
| Any focused backend structure test command | at most 15 s |
| Rust cached structure replay | at least 1,000 pages/s |
| All 24,707 successful native pages, cached replay | at most 30 s |
| Text-only SourceDoc recovery | at least 50 MiB/s after process warmup |
| Kraken-lite Quality, settled GPU | at least 5.5 pages/s |
| Kraken-lite Quality, laptop profile | at least 2.0 pages/s |
| Selective OCR over all 750 non-digital documents on GPU | at most 60 min |

Do not run a clean whole-workspace build during an ordinary edit. Use one
package-scoped metadata/check command, batch edits, then link once for the final
behavioral gate. Do not spawn one structure process per document in production
or corpus gates; use an in-process library or one warmed persistent/batched
sidecar.

The budgets above are completion gates, not invented baseline claims. Current
measured reference points are a 0.799 s warm `cargo quick`, a 0.513 s
all-provider smoke including Vitest startup, and 293.1 cached page-passes/s for
the preliminary 11-document Rust parity sample when the executable is invoked
per document. The full 748-document replay establishes the real baseline. The
1,000 pages/s and 30 s goals require the final warmed/batched architecture; an
ownership-only move first has to remain within 2% of its frozen baseline.

### 18.4 Proof and compact-provenance policy

The harness is auto-self-documenting. Each run writes one bounded phase JSON
containing:

- schema, stage, command contract, commit and subrepo hashes;
- source/corpus manifest hash, parser/model/config identities, and cache state;
- attempted/completed/failed document and page counts;
- exact baseline/candidate output hashes and categorized deltas;
- median/p95 wall time, throughput, peak memory where available, and artifact
  bytes; and
- pass/fail for every applicable invariant and budget.

Do not accumulate process theatre. No per-command diary, screenshots of green
tests, duplicated result trees, copied PDFs, copied page images, or full
baseline/candidate JSON pairs are durable evidence. Raw outputs live in one
ignored content-addressed cache, are overwritten/reused by stage, and can be
deleted after their hashes and compact failure exemplars are recorded. A full
corpus parity run retains one hash row per document plus bounded examples for
each delta class. Long jobs update one atomic partial summary and one compact
per-document receipt so interruption never discards completed work.

### 18.5 Fine-grained execution stages and acceptance gates

#### Stage 0 — harness and baseline

- **Result:** one command can measure source, build, provider fixtures,
  structure replay, output hashes, throughput, and artifact size.
- **Whole-corpus proof:** reconstruct replay inputs from the existing 748
  native extraction caches without reparsing PDFs; hash every current result.
- **Tests:** harness self-test rejects a changed byte, missing document,
  mismatched subrepo pin, exceeded budget, and stale cache identity.
- **LoC:** tooling only; zero production growth.
- **Speed:** representative smoke finishes under 2 s; record rather than hide
  the full cached baseline. Do not require old per-document startup behavior to
  meet the final 30 s/1,000 pages/s target.
- **Receipt:** one baseline summary plus one compact 748-row hash manifest.

#### Stage 1 — Rust ownership extraction

- **Result:** the semantic structure core has a provider-neutral library input
  and output; Legal PDF Parser is an evidence adapter plus projection caller.
- **Whole-corpus proof:** all 748 successful native document result bytes are
  identical before and after the move, not merely schema-equivalent.
- **Tests:** all current Rust structure/pairing/projection tests plus exact
  common-input replay differential.
- **LoC:** net production growth at most zero when the old ownership path is
  deleted; no copied Rust/TypeScript implementation.
- **Speed/build:** no replay regression above 2%; warm `cargo quick` and final
  link stay within Section 18.3.
- **Receipt:** before/after engine hashes, 748 exact matches, timings, and LoC.

#### Stage 2 — SourceDoc provider breadth freeze

- **Result:** one applicability matrix covers every real SourceDoc-producing
  provider and every mode that provider actually exposes. A mode with no real
  captured baseline is incomplete; a synthetic/mock row cannot turn it green.
- **Whole-corpus proof:** run all existing A2AJ/provider fixture corpora and
  frozen legacy outputs, then add the missing real captures identified in
  Section 18.8. Every row compares the pre-refactor and candidate canonical
  public output bytes; native provider blocks/anchors remain byte-identical.
- **Tests:** assert root-at-1/gapless inferred sequences, source text, locators,
  ranges, page/footnote ordering, native-block preservation, and failed-closed
  gaps for every applicable lane.
- **LoC:** the gate belongs in experiments or replaces narrower duplicate tests;
  no production growth.
- **Speed:** real-capture parity smoke under 1 s, comprehensive provider suite
  under 8 s, and 2.3 MiB text fixture under 100 ms after warmup.
- **Receipt:** one provider/mode row with source, output hash, invariants, and
  elapsed time.

#### Stage 3 — shared-engine provider integration

- **Result:** provider adapters pass native claims and missing text ranges to
  one warmed shared engine; they do not surrender trustworthy native structure.
- **Whole-corpus proof:** every Stage-2 fixture is byte-identical during the
  ownership cutover, including every non-native path.
- **Tests:** persistent protocol batching, version/schema refusal, crash/error
  isolation, native-claim precedence, and exact projection parity.
- **LoC:** delete SourceDoc detector copies as each family moves; the completed
  stage must contract whole-project production by at least 300 lines.
- **Speed:** no per-document spawn; at least 50 MiB/s text recovery and no
  provider fixture more than 5% slower.
- **Receipt:** protocol identity, batch size, parity hashes, throughput, LoC.

#### Stage 4 — monotonic numbered streams

- **Result:** paragraph/provision/section/note/page candidates share the proven
  origin-at-1 and monotonic-successor selector with explicit grammar/restarts.
- **Whole-corpus proof:** run every SourceDoc provider corpus plus all cached
  native PDFs; list every origin, gap, jump, duplicate, restart, and collision.
- **Tests:** repeated starts, TOCs, quoted provisions, numeric tables, forms,
  transcripts, endnote tails, missing-marker recovery, and custom marks.
- **LoC:** one selector replaces all descendants; net production contraction.
- **Speed:** linear or bounded-near-linear scan; all native cached replay under
  30 s and provider matrix under 8 s.
- **Receipt:** per stream-family counts and bounded audited delta examples.

#### Stage 5 — notes and propositions

- **Result:** reuse existing strong reference/body/pair/restart/proposition
  logic through the shared engine; make only corpus-proven modest corrections.
- **Whole-corpus proof:** all 1,500 documents after OCR materialization, plus
  frozen 661-page journal truth, with apparatus modes reported separately.
- **Tests:** numeric/symbolic labels, restarts, continued notes, endnotes,
  tables/forms at page bottoms, citation/paragraph collisions, crossrefs, and
  proposition spans.
- **LoC:** delete hand-parsed grammar shadows; no net production growth.
- **Speed:** note work remains a small fraction of cached replay and never
  triggers model inference on digital-native pages.
- **Receipt:** pair/proposition invariants and audited intended deltas only.

#### Stage 6 — physical and printed pages

- **Result:** preserve the existing page solution and fix only confirmed edge
  cases: Roman/prefixed labels, transitions/restarts, alternating folios, and
  furniture conflicts.
- **Whole-corpus proof:** all 1,500 PDFs have complete physical page sequences;
  every printed-label transition/gap is enumerated and audited by class.
- **Tests:** covers/front matter, Roman-to-Arabic, attachments, prefixed pages,
  missing labels, restarts, transcript folios, and false paragraph/date labels.
- **LoC:** consolidate with the shared monotonic primitive; no growth.
- **Speed:** page reconciliation is linear and does not affect replay budget.
- **Receipt:** physical exactness plus transition/gap histograms.

#### Stage 7 — prose paragraph boundaries

- **Result:** port Text-Fidelity geometry break evidence; keep inferred prose
  groups separate from legal numbered units and locators.
- **Whole-corpus proof:** compare native/BLLA line geometry on all applicable
  pages; preserve text, line IDs, order, provider blocks, and real paragraph
  labels exactly.
- **Tests:** large gaps, sentence-indent, block-start indent, columns, tables,
  headings, soft-hyphen/must-follow edges, block quotes, and inverted note
  hanging indents.
- **LoC:** reuse/port the existing primitive once; delete region-as-paragraph
  logic; completed stage net-negative.
- **Speed:** paragraph grouping stays inside the 1,000 pages/s replay budget.
- **Receipt:** boundary evidence counts, collisions, and chunk/locator checks.

#### Stage 8 — digital-native whole-corpus acceptance

- **Result:** all 750 digital-born PDFs parse, or an ingestion failure has an
  explicit recovery/failed-closed receipt; current two CanadaBuys failures are
  resolved or bounded.
- **Whole-corpus proof:** 24,779 attempted pages, exact source accounting,
  structure invariants, provider consumer lookups, and audited delta classes.
- **Tests:** cached replay every edit; full extraction only at stage close.
- **LoC:** whole-project ceilings and contraction target pass.
- **Speed:** cached proof under 30 s; one full native extraction pass under
  12 min, resumable and parallel without duplicate outputs.
- **Receipt:** 750 compact rows plus one phase summary.

#### Stage 9 — non-digital Kraken-lite materialization

- **Result:** every one of the 750 non-digital PDFs is assessed; pages needing
  OCR use the settled Kraken-lite profile and all usable native pages remain
  native.
- **Whole-corpus proof:** 86,763 physical pages, routing reason per page,
  model/runtime hashes, source-anchor accounting, and resumable completion.
- **Tests:** small cross-cutting smoke before launch; recognition/segmentation
  contract, native preservation, cache replay, and interruption/resume.
- **LoC:** experiment runner only unless a measured production defect appears.
- **Speed:** at least 5.5 pages/s GPU and 2.0 pages/s laptop; selective GPU lane
  under 60 min. Reject repeated model/process startup if it threatens budget.
- **Disk:** no copied PDFs/page images; compressed reusable OCR evidence under
  10 GiB excluding sources/models.
- **Receipt:** 750 compact rows, atomic partial summary, and final routing/
  throughput/artifact summary.

#### Stage 10 — intentional quality improvements and machine silver

- **Result:** only audit-backed structure deltas are admitted; Luna silver is
  bounded to unresolved cases and never repairs ordinary native mechanics.
- **Whole-corpus proof:** all 1,500 documents, stratified by source, kind,
  generation, layout, length, and hardware profile; existing human truth is
  regression-only.
- **Tests:** consumer-level exact lookups, hierarchy, note/proposition pairs,
  tables/forms/TOCs/transcripts, source accounting, and abstention.
- **LoC:** no new shadow detector/resolver; final target at most 124,500
  production and 180,500 production-plus-test lines.
- **Speed:** deterministic replay budgets still pass; no metered inference is
  run without explicit authorization.
- **Receipt:** categorized intended deltas, quality metrics, costs if
  authorized, and held-out machine-silver hashes.

#### Stage 11 — release close

- **Result:** old detector implementations and temporary compatibility paths
  are gone; one engine and one authored grammar corpus ship.
- **Whole-corpus proof:** repeat provider, 750-native, 750-non-digital, grammar,
  source, build, binary-size, disk, and release gates from clean locked commits.
- **Tests:** repository release checks plus the compact harness; no redundant
  full corpus copies.
- **LoC:** meet the completion contraction targets, not merely the ceilings.
- **Speed:** every Section-18.3 budget passes on the recorded hardware.
- **Receipt:** one final manifest linking compact phase receipts and exact
  commit/subrepo/model/corpus hashes.

### 18.6 Mandatory execution order and change isolation

The gates are ordered. A later green gate cannot excuse an earlier failure.

1. Freeze inputs, baseline binaries/commits, serializers, provider modes,
   corpus membership, and existing failures before changing production.
2. Prove the harness detects deliberately corrupted outputs and incomplete
   work before trusting a green receipt.
3. Perform the Rust ownership extraction with zero output changes.
4. Prove real baseline parity for every SourceDoc-producing provider and each
   applicable native/hybrid/flat-text mode.
5. Cut one caller/mode at a time to the shared engine, retaining exact parity,
   and delete its displaced detector in the same accepted slice.
6. Only after all ownership gates are exact may one structure family change at
   a time: sequences, notes, pages, headings, then prose boundaries.
7. Re-run every locally available applicable corpus after each intentional
   semantic family closes, and all of them once more at release.
8. Start machine-silver/model work only after deterministic digital-native
   mechanics and provider integration pass.

Do not mix an ownership move with a quality improvement. An ownership commit
has zero accepted deltas. A quality commit has an explicit delta manifest and
must remain byte-identical outside its named fields/documents. If output moves
unexpectedly, the slice is not promoted until the cause is classified and the
proof is rerun from the frozen baseline.

### 18.7 Exact parity contract

“Parity” means a real pre-refactor implementation and the candidate both run
over the same real frozen input. It never means that the candidate agrees with
itself, passes its own invariants, or matches a synthetic object.

For every document/provider-mode row, retain and compare:

- exact source/input byte hash and stable document identity;
- baseline commit, locked subrepo commits, binary hash, feature set, grammar
  hash, serializer version, material options, and provider mode;
- raw transport bytes where the public contract is serialized;
- a canonical public-object serialization with ordered arrays preserved and
  only object-key order normalized;
- canonical text bytes and exact source-anchor/span/line/box identities;
- every ordered block tuple, including kind, label, offsets, anchor, origin,
  aliases, parent, continuation, confidence, and exclusions where present;
- range/index state, missing labels, status, mode, revision hash, diagnostics,
  and abstentions;
- normalized lookup results for every emitted label/alias and bounded negative
  lookups around each range; and
- consumer projections used by Legal PDF Parser, SourceDoc, evidence lookup,
  chunking, and note/proposition retrieval.

The parity serializer is frozen before the port and hashed in the receipt. It
cannot be changed in the same slice as the engine. Where the product already
emits deterministic bytes, both raw bytes and canonical bytes must match. A
canonical match cannot conceal changed transport bytes. Timing fields and
machine-local paths must not enter the public object in the first place; they
belong in the run receipt.

Baseline generation and candidate execution must be independent:

- use separate pinned worktrees/binaries or an already frozen accepted binary;
- the candidate may not call the baseline, copy its result, or fall back to it;
- the baseline may not be regenerated from candidate source after work starts;
- common extraction input may be reused only when its byte hash and extraction
  boundary are frozen, and both engines must still execute structure logic;
- baseline and candidate caches use separate namespaces and complete keys; and
- the final clean-lock rerun verifies that no dirty file supplied hidden code
  or altered evidence.

Every baseline row is real. Synthetic and adversarial fixtures remain useful
unit tests, but they can never satisfy provider or corpus parity denominators.
Missing real evidence makes the row incomplete and the release gate red.

### 18.8 Provider-by-mode real-baseline matrix

The matrix lists only modes a provider actually exposes. “Every provider” does
not mean fabricating all three modes for each provider. It means that every
shipping SourceDoc-producing route has a real frozen row and exact parity.
Hansard is currently a string artifact rather than a SourceDoc provider and is
outside this matrix unless it starts producing SourceDoc during the work.

| Provider/path | Applicable real modes | Required baseline proof | Current gap before migration |
| --- | --- | --- | --- |
| A2AJ cases | flat-text recovery | real captured decisions, including bracketed, bare, TOC, unnumbered, and endnote shapes; exact SourceDoc and lookups | expand the four legacy byte recordings to the full captured case fixture set and local corpus |
| A2AJ laws | native/hybrid section-map plus flat recovery | real statutes/regulations across all local sets; exact native claims and recovered ranges | freeze canonical public bytes for every fixture/corpus row before moving the selector |
| CourtListener | CAP/native and ordinary HTML hybrid/flat | real captured provider payloads for each applicable mode | CAP is real; synthetic hybrid/flat edge cases do not satisfy parity and need real captures |
| TNA | native Akoma Ntoso | real captured judgment markup and exact eId/anchor/block output | broaden beyond the current one real capture if other local captures exist |
| GovInfo | flat text today | preserve the real capture's current text, status, mode, and unavailable locator state exactly | add a real structured capture before claiming recovery quality; do not invent blocks to make the row green |
| GOV.UK ET | flat text today | preserve the real capture's current text, status, mode, and unavailable locator state exactly | add a real structured capture before claiming recovery quality; current abstention is a parity result, not a quality pass |
| Journal | final-contract native, legacy hybrid, missing-kind recovery | real captured article/database rows for every mode; exact text, full block tuples, ranges, aliases, and lookups | freeze a new canonical baseline because the old recording predates alias-aware range counts |
| Local PDF | Rust projection through TypeScript adapter | at least one real compact PDF and its real Rust `source_doc` bytes, then exact adapter text/block/anchor/alias/parent/range/lookup bytes | current backend row is synthetic/mocked and is not parity evidence |

A provider/mode may migrate only when its own real row and every broader local
corpus containing that mode are green. Provider-native text spans, labels,
boundaries, anchors, aliases, parentage, exclusions, and order remain exact.
Inference may fill an absent structure kind or an explicitly missing range; it
must never renumber or replace a native claim. A conflicting native claim is
preserved with a diagnostic unless source identity itself is proven invalid.

The first fail-closed coverage ledger has 17 required provider/mode rows. Eight
currently have real captured canonical baselines; nine remain explicitly
missing. Therefore provider acceptance is currently red even though the fast
real-capture differential passes. The missing rows are A2AJ native-only
section maps, CourtListener hybrid and flat opinions, TNA hybrid fill,
journal native and flat modes, and local-PDF native/hybrid/flat Rust-to-TS
captures. This denominator cannot shrink merely because investigation later
shows a mode is rare; applicability must be disproved from real provider/corpus
evidence and the ledger change reviewed separately.

### 18.9 Shared-engine boundary and sequence invariants

The shared engine accepts evidence; it does not fetch providers or parse PDF
containers. Its minimum neutral input is:

- immutable document/source identity and exact canonical text;
- ordered source anchors with text offsets and optional page/line/word/span,
  box, font, style, language, flow, and orientation evidence;
- provider-native claims and explicit precedence/provenance;
- excluded/protected ranges such as citations, tables, TOCs, forms, quoted
  instruments, furniture, and other non-spine zones;
- candidate roles, enumerators, paragraph-break edges, and grammar match IDs;
- declared complete-document versus excerpt scope; and
- model/runtime evidence as proposals, never anonymous truth.

It returns one anchored structure graph: source order/flows, prose groups,
numbered units, pages, headings/hierarchy/section spans, notes/references/
propositions, list/table/form/TOC/caption relations, diagnostics, conflicts,
and abstentions. Provider integration, fetching, caching policy, SourceDoc
index construction, and application projection remain outside the engine.

Sequence rules are evaluated per namespace, never by accepting every number on
a page:

- all internal object identities and physical pages are exactly `1..N`;
- an inferred complete-document paragraph, footnote, endnote, end-reference,
  or ordinary numbered-unit ladder begins at observed 1 and accepts ordinary
  successors of `+1`;
- a printed/provider semantic label such as reporter page 335 or statute
  section 22 is preserved separately from its internal one-based identity;
- Roman, alphabetic, decimal, multipart, prefixed, and custom-mark ladders use
  an explicit grammar with an explicit origin, successor, nesting, transition,
  and restart scope;
- a missing origin, internal gap, jump, duplicate, competing late ladder, or
  unexplained restart fails closed for inferred digital-native structure;
- a truly incomplete provider excerpt or unrecoverable OCR gap is retained as
  incomplete with direct provenance and a diagnostic, never silently promoted
  to a complete sequence; and
- table values, transcript line numbers, dates, citation pinpoints, TOC target
  pages, form questions, quoted provisions, notes, headings, and document
  paragraphs remain different streams even when their tokens coincide.

For every accepted structure family, require both false-positive and
false-negative evidence. Count-only output is insufficient. The proof surface
must cover headings and hierarchy, numbered units, physical/printed pages,
prose paragraph boundaries, note references/bodies/pairs/propositions, lists,
TOCs/indexes, tables, figures/captions, forms, furniture, reading order/flows,
continuations, exclusions, and abstention. Where no independent truth exists,
claim exact parity and invariant validity only—not improved accuracy.

### 18.10 Every-local-corpus proof registry

Before the first production change and again at release, the harness scans the
known repository, subrepository, ignored benchmark, and configured local-data
roots and writes one compact corpus registry. Each row records:

- corpus ID, owner, path identity without private content, input type, truth or
  oracle type, and applicable structure gates;
- exact file/document/page/record denominator and byte size;
- a sorted membership manifest hash and hashes of every manifest/truth/index;
- duplicate-byte groups without dropping their document aliases;
- baseline availability, expected historical failures, cache availability,
  and whether the row is runnable offline; and
- an explicit inclusion result or a narrowly stated machine-checkable reason
  the corpus cannot exercise this engine.

An applicable discovered corpus that is absent from the registry fails the
run. An exclusion cannot be a broad glob such as `old`, `slow`, `large`,
`legacy`, or `unsupported`; it must prove that the data cannot reach the shared
engine. New or changed local corpus membership invalidates the earlier receipt
and expands the denominator automatically. Exact duplicate bytes may share one
expensive parse, but every alias remains in source accounting and receives the
same result hash. Historical summaries do not substitute for a runnable corpus
whose source bytes are missing; such a row is reported as historical evidence,
not a current pass.

Known applicable local surfaces to register immediately include at least:

| Surface | Known current/historical denominator | Required proof |
| --- | ---: | --- |
| Universal legal-PDF corpus | 1,500 PDFs: 750 digital-born + 750 non-digital | every document and physical page accounted; both lanes share semantic output contract |
| Acquisition ledger | 4,693 rows / 1,735 accepted, but exactly 1,500 accepted rows currently map to materialized PDFs | provenance accounting only; the 235 accepted-but-unmaterialized rows cannot inflate or replace the run denominator |
| Digital-native extraction/cache lane | 750 documents / 24,779 attempted pages; 748 documents / 24,707 pages currently materialized; two CanadaBuys failures / 72 pages | full baseline and candidate hashes; failures remain explicit and are not removed from denominator |
| Non-digital lane | 750 documents / 86,763 physical pages; 15,795 pages are currently only a sparse-routing estimate | route every page; OCR every routed page; prove native-page preservation and exact routing denominator |
| Deterministic cross-lane sample | 120 PDFs / 10,435 pages, but current cache has only 36 pairs / 1,627 pages and historical summary completed two | execute all 120 before making a sample claim; partial caches/summaries stay explicitly partial |
| Public cache-contract PDFs | 8 PDFs / 425 pages, all locally present | cold/warm/prepare/selected-page/lookup/corrupt-cache/source-identity parity through a new batched gate; the old 4,127.5 s / 14,264-call method is rejected as too slow |
| Historical frozen journal qualification | 1,024 articles / 27,391 pages / 8,192 product sidecars, not currently materialized | historical evidence only until exact source inputs are local again; it cannot be a current release pass |
| Historical external digital-born qualification | 29 URL rows and prior 1,445-page / 232-sidecar results, but source PDFs are not local | historical evidence only; URLs are not runnable corpus bytes |
| Legal OCR benchmark | 153 pages: 123 manual gold + 30 reviewed silver | recognition, segmentation, routing, structure, and speed using the frozen split |
| Text-Fidelity ordered journal truth | 661 pages / 350 articles / 32,553 lines in local revision `_01` | regression only; reconcile the `_01` versus OCR plan's accepted `_05` identity before any OCR-quality claim; no new user labeling |
| Legal25 layout holdout | 87 pages / 975 annotations / 25 categories; consumer join covers only 48 pages | region accuracy on all 87; line-role/order/note claims only on their actual 48-page joined denominator |
| Real-document layout surface | 1,500 images / 1,500 annotations | region-detector breadth only, never a semantic-structure denominator |
| Local structure-stress corpora | most recent historical sweep: 330,473 A2AJ cases, 36,927 A2AJ laws, and 2,494 journals | remeasure live membership, then full provider/grammar/sequence proof over all present rows |
| Current installed A2AJ full-text store | 248,685 documents: 225,017 cases + 23,668 laws | exact pre-refactor/candidate SourceDoc and lookup hashes over every row; reconcile membership difference from the historical sweep rather than choosing the smaller denominator |
| Current local CourtListener bodies/audit | 55,504 installed opinion bodies and 69,393 audited rows in 71 completed parts | full real native/hybrid/flat classification and parity; metadata-only rows remain separately accounted |
| Current local journal database | 18,958 articles / 404,506 article-page rows; FTS sidecar currently indexes 18,595 articles | all articles and page rows accounted; exact native/hybrid/flat output by actual applicability |
| CanLII title/index corpus | historical local index: 3,538,714 case titles + 91,669 legislation titles | grammar/citation collision and membership proof where structure engine consumes those matches |
| SourceDoc captured fixtures | currently 21 A2AJ SourceDoc JSON files and 7 native-markup JSON files | real-input canonical baseline per applicable provider/mode; synthetic rows separately labeled |
| Legal generalization corpus | 31 raw/text document pairs | manifest/hash fidelity plus all heading/numbered-unit/paragraph/note/page outputs |
| Canadian structure truth | 10 statute + 8 decision structure-gold documents | exact hierarchy/sequence/anchor scoring |
| U.S. public-laws USLM truth | 79 XML documents currently present | native hierarchy/identifier preservation and shared projection parity |
| Bilingual amending Acts | 16 text artifacts currently present | English/French grammar, sequence, heading, and parallel-flow proof |
| Local DOCX legal corpus | 24 byte-unique documents, 2,009 notes / 1,860 unique note texts, plus the frozen 405-row accepted ALR split where present | cross-format text/note/proposition/structure regression and matching PDF equivalents where present |
| Harvested grammar vectors | 271 rows across negative/reference/raw/splitter/TOA groups | assert all 271; the current 18-of-31 splitter oracle cannot be reported as full coverage |
| Authored legal grammar corpus | 64 entries / 252 vectors | every shipping runtime loads the same bytes and returns exact match spans for every vector |
| Kraken named splits | benchmark 153, heldout/manual 55, validation/manual 68, silver 30, and probe 12 | report each split by its own manifest; aliases do not double the denominator and silver is not gold |
| Scan-silver candidates | 42 PNG/XML candidates / zero verified pages | mechanics only; no OCR-quality claim |
| Court scan corpus | 115 PDFs / 650 PNGs / 290 XMLs / four verified pages | mechanics over all artifacts; quality on exactly four verified pages |
| CourtListener scan silver | 33 PDFs / 270 candidate groups / 26 verified pages | silver mechanics on candidates; OCR quality on exactly 26 verified pages |
| Kraken/PP-DocLayout/BLLA remaining held-out and ablation sets | dynamically inventory every frozen split and truth file under parser experiments | recognition, segmentation, region proposal, anchor coverage, and postprocessing parity by named split |

This table is a floor, not an allowlist. Stage 0 must discover additional local
applicable surfaces, including ignored accepted gold, cached provider exports,
real PDF regression fixtures, and browser/runtime held-outs. Every discovered
surface must be registered and run, or explicitly proven irrelevant.

### 18.11 Anti-skip, anti-cache, and source-accounting rules

For each corpus, freeze the denominator before execution. A passing receipt
requires:

```text
attempted = passed + intended_delta + expected_failure
skipped = 0
unclassified_failure = 0
duplicate_id = 0
missing_input = 0
```

Expected failures remain in the manifest with their frozen error class and
bytes. A timeout, crash, parse error, oversized document, missing model,
unsupported type, or absent provider credential is a failure, not a skip.
Large, slow, multilingual, scanned, malformed, image-heavy, table-heavy, or
previously troublesome documents cannot be filtered from the release run.
Samples are permitted only for fast inner loops and must be named `smoke`; a
smoke receipt can never satisfy a corpus or release gate.

Cache keys include input bytes, baseline/candidate binary, engine/schema/
serializer/grammar versions, model/runtime/config hashes, feature flags, and
material hardware-dependent options. Each row reports hit/miss and the exact
cache-key hash. The harness must prove:

- a deliberately stale binary/model/grammar/input key misses;
- cold and warm executions produce exact same public bytes;
- corrupted/truncated cache entries are rejected rather than counted;
- baseline and candidate never read each other's semantic outputs;
- extraction caches are reusable only across a frozen extraction boundary;
- selective OCR reports a route reason for every page, and native pages do not
  disappear merely because they bypass recognition; and
- interruption/resume produces the same final manifest as an uninterrupted
  run.

Every document result accounts for source anchors exactly once. Every physical
PDF page is present exactly once. Every source text byte/span is retained,
explicitly excluded with reason, or explicitly repaired with an anchored
operation. Hash equality on a summary cannot substitute for document rows.

### 18.12 Anti-test-weakening and harness self-tests

The harness is not trusted until its negative controls fail. Automated
self-tests must independently inject and detect at least:

- one changed output byte and one changed source byte;
- a deleted, duplicated, renamed, and reordered document row;
- a missing provider mode and a synthetic row substituted for a real row;
- a changed native anchor, alias, parent, origin, range, lookup, or mode while
  preserving text;
- a sequence missing 1, an internal gap, duplicate, restart, and competing late
  ladder;
- an omitted page, OCR-routed page counted as native, and failed page removed
  from throughput denominator;
- a stale/corrupt cache, changed binary/model/grammar hash, and baseline cache
  reused as candidate output;
- a deliberately weakened/removed fixture, assertion, corpus registry row, or
  expected-failure entry;
- a receipt edited after generation, a truncated atomic checkpoint, and a
  phase marked green with a red child row;
- a dirty or unpinned subrepo, hidden untracked production source, and a source
  file moved into an excluded directory or uncounted extension; and
- a timing run that drops failures, startup, or slow documents from its work
  denominator.

Baseline fixture, serializer, corpus-registry, expected-failure, and assertion
manifests are hashed at the baseline commit. Changing one during the port
invalidates parity and demands a separately reviewed baseline-update phase.
Deleting or loosening tests cannot make a slice pass. The receipt reports test
files, assertions/cases, real fixture rows, and applicable provider modes
before and after; reductions require an explicit replacement mapping to a
stronger public-outcome test.

### 18.13 Anti-LoC and anti-architecture evasion

The source gate counts the root plus every locked subrepository. It also
reports authored production, tests, experiments, tooling, generated code,
vendored code, grammar/data bytes, dependency count, binary size, and tracked
artifact size separately. The following do not count as contraction:

- moving code to a subrepo, script, experiment, fixture, generated file,
  build step, vendored directory, untracked file, new extension, or dependency;
- minifying/compressing authored logic or encoding it as large JSON/regex/data
  tables;
- deleting tests, corpus rows, diagnostics, or public behavior;
- retaining the old detector behind a fallback, feature flag, compatibility
  alias, subprocess, generated wrapper, or “temporary” migration path; or
- linking both implementations and selecting the one that matches the
  baseline.

The line classifier and its extension/directory rules are themselves frozen
and self-tested. Any new authored extension or executable input is classified
before the gate runs. A dependency or code-generation change reports its
maintained-source and binary impact even if npm/Cargo vendor files are excluded
from production LoC. The accepted engine must have one semantic implementation
in the dependency/call graph. Static inventory and runtime counters prove that
each recovery route invokes it and that no old semantic detector remains.

Provider adapters may preserve and pass through native structure but may not
grow replacement detection logic. The shared engine may not absorb provider
fetching, provider URL policy, SourceDoc query/index code, or PDF container
recovery. Rust is accepted only if the measured direct-link plus warmed host
path meets exact parity, build, throughput, memory, binary, deployment, and
whole-project contraction gates. A Rust wrapper around retained TypeScript—or
the reverse—is not the refactor.

### 18.14 Performance-proof integrity

Performance receipts identify CPU, core/thread count, RAM, OS, storage,
GPU/VRAM, power profile, runtime versions, process concurrency, batch size, and
cache state. Compare the same frozen manifest and configuration with alternating
baseline/candidate runs. Report cold start separately from warmed throughput,
and report median and p95 over repeated runs. Include initialization,
serialization, failures, retries, and process startup in end-to-end wall time;
an internal kernel timer may be reported only as an additional metric.

The numerator comes from the frozen source manifest, not successful output
rows. A faster result that processed fewer bytes/pages/documents, changed OCR
routing, reduced resolution, disabled a structure family, increased
abstention, or used a different accuracy profile fails. Concurrency may change
only when it is the intended shippable configuration and memory/disk ceilings
still pass. Record peak RSS, GPU memory, artifact/model/binary bytes, cache
growth, and temporary peak disk—not only steady-state throughput.

Ordinary development uses warm package-scoped checks and cached structure
replay. One controlled package-scoped cold/offline build and one final clean
locked release build prove reproducibility; repeated clean builds are process
theatre. Build work is itself timed and cannot be excluded from the build
budget by prebuilding an unrecorded binary.

### 18.15 Quality-change proof and no-new-annotation rule

After exact ownership parity, an intentional semantic change needs:

- a named recurring failure class and the exact documents/fields expected to
  change;
- stronger source/provider/manual-gold/machine-silver evidence than the old
  output, with source anchors sufficient to reproduce the judgment;
- false-positive and false-negative results for the affected structure family;
- zero source-text/anchor loss and zero unrelated public-output delta;
- no regression on any real provider mode or local corpus, including corpora
  outside the one that motivated the fix;
- an allowlist generated from the proposed run and verified on an independent
  rerun, never a wildcard or count-only tolerance; and
- a bounded before/after exemplar for each delta class plus full hash rows.

No new user annotation, page verification, or tagging is a project dependency.
The existing 661-page journal truth, OCR truth, provider-native claims,
structure gold, and other accepted local gold are frozen regressions. Agent
inspection diagnoses mechanics and validates machine-generated evidence; it
does not create a new human-labeling obligation. Where local truth is absent,
the plan permits exact parity, deterministic invariants, native-oracle checks,
or machine silver after authorization—it does not permit an unsupported
accuracy claim.

### 18.16 One fail-closed harness interface

The target interface is one command with explicit scopes:

```text
npm run check:legal-structure -- --stage quick
npm run check:legal-structure -- --stage parity
npm run check:legal-structure -- --stage providers
npm run check:legal-structure -- --stage all-local-corpora
npm run check:legal-structure -- --stage native-pdf
npm run check:legal-structure -- --stage ocr
npm run check:legal-structure -- --stage release
```

`quick` runs source/lock guards, real-provider smoke, harness negative controls,
and a fixed representative cached replay. `parity` runs every frozen
baseline/candidate row. `providers` runs every real provider-mode fixture and
every locally present provider corpus. `all-local-corpora` dynamically verifies
the registry and runs every applicable local surface. `native-pdf` and `ocr`
run their exact complete denominators. `release` composes all prior receipts,
reruns clean-lock identity checks, and refuses stale children.

Each stage writes one compact atomic JSON receipt and, only where needed, one
compressed row manifest. Receipts include parent/child hashes and expire when
code, inputs, manifests, models, configuration, hardware-sensitive options, or
subrepo pins change. The verifier recomputes hashes and invariants; hand-edited
receipts fail. Exit status is nonzero for missing, stale, skipped, incomplete,
over-budget, dirty, unpinned, or unexpectedly changed work. There is no
warning-only release state.

### 18.17 Current gate state — 2026-08-19

No stage is being called complete prematurely:

- The whole-project source guard self-test passes. It now includes untracked
  authored files inside subrepositories and `.cmd` source. It correctly fails
  the current dirty slice because Legal PDF Parser contains an uncommitted
  parity harness and production-plus-test source is temporarily over the
  corrected baseline ceiling. Production source itself has not grown.
- The Rust baseline harness has now hardened the full denominator: 750 audit
  records = 748 cached successes plus the two explicit ingestion failures.
  The independent resumed check passed 748/748 documents / 24,707 pages with
  zero replay failures and aggregate output SHA-256
  `eca681b34db5186d7689f1532f401c9e311c4aa85a11a73a151b0dd29c50d9d3`.
  Its fresh 168.628 s run achieved only 147.3 pages/s and therefore correctly
  failed the unchanged 250 pages/s interim speed gate. This freezes Stage-0
  bytes but does not satisfy the ownership-refactor or final 1,000 pages/s
  gates; production Rust remains unchanged.
- The SourceDoc coverage ledger has 17 provider/mode rows: eight real captured
  baselines are frozen and exact, while nine missing real captures keep the
  acceptance gate red. Synthetic/mocked cases remain unit tests only.
- The non-digital runner has verified the full local manifest and exact
  denominator of 750 documents / 86,763 physical pages. Its first CUDA product
  smoke correctly failed when all CPU execution-provider fallback was
  forbidden: the settled model has a small unavoidable CPU-node assignment.
  The exact run is now live without a rebuild using the same frozen binary and
  model, with `fallback=cpu` explicitly enabled and identity-pinned. The first
  durable checkpoint has 76/750 documents passed, zero failed, and 101/86,763
  physical pages accounted; 60 pages were detector-marked, 73 OCR attempts
  were routed, and 70 OCR pages were emitted. This is progress, not a corpus
  completion claim, and the image-only 6.263 pages/s result remains distinct
  from end-to-end product throughput.
- The dynamic all-local-corpus registry and its negative controls remain Stage
  0 work. The inventory floor in Section 18.10 is not yet a green receipt.

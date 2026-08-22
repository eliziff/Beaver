# Document-structure evidence and retained requirements

Date recorded: 2026-08-20

Status: supporting evidence, not an active implementation plan. The current
architecture and sequence are in
[Shared document structure](../roadmap/document-structure.md).

This appendix preserves unique measurements, vocabulary, detector invariants,
primitive and witness inventories, citation-consolidation requirements,
OCR/repair evidence mappings, ALR acceptance requirements, and the paired-note
reading-order experiment. Statements below about repository shape, ownership,
or build order describe the historical proposal and are superseded by the
current plan; they are retained only where they explain an evidence contract.

## Current evidence

The diagnostic run over 748 PDFs and 24,707 pages established two useful
facts:

- the numbered-paragraph profile found 4,148 candidates in 148 documents;
  every selected sequence began at 1 and had no gap;
- the instrument profile found 49,659 section candidates in 451 documents.

The latest candidate replay completed in about 49.5 seconds and the checker
including audit hashes completed in about 51.5 seconds (roughly 500
pages/second), but that run was rejected: it produced zero exact document
matches and 748 output mismatches. It is timing evidence only. The last
accepted frozen exact replay remains 748/748 documents, 24,707 pages, 27.044
seconds, and 913.6 pages/second. It passes the 30-second wall-time gate but not
the separately pinned 1,000-pages/second throughput gate. Neither frozen path
is the Phase 1 corpus runner.

The sequence mechanics are therefore strong. The semantic assignment is not.
Clean sequences still included transcript indexes and contents rows, and the
section profile sometimes treated running paragraphs as provisions. Conversely,
the same section grammar recovered large, coherent bylaw and rules hierarchies.

The current PDF engine already preserves useful native work:

- repeated furniture and alternating folios;
- printed page labels;
- page geometry, spans, font attributes, superscripts, blocks, regions, and
  reading order;
- source-region contracts where a layout provider supplies them;
- painted and raster-detected note-band separators;
- detached, spliced, inline, and superscript note references;
- bottom, margin, multi-column, continuation, and endnote region modes;
- note-label backbones, restart handling, gap repair, repeated-reference
  handling, and reference/body pairing;
- protected citation spans and citation-signal detection;
- heading enumerator grammar, heading ladders, typography, body-flow demotion,
  wrapped-heading continuation, and structural resets;
- table captions, grid evidence, contents-grid detection, table cells, and
  table notes;
- single-, two-, and margin-column models plus reading-order arbitration;
- physical prose regions, sections derived from accepted headings, and
  proposition/cross-reference attachment.

The resolver must consume these primitives. It must not reconstruct weaker
versions from flattened paragraph text.

## Vocabulary

- **Observation:** extracted fact such as a bounding box, painted rule,
  superscript span, line text, or source role.
- **Primitive claim:** an existing detector result such as `heading`,
  `footnote`, printed page label, note-band cut, table cell, or paired note.
- **Candidate:** a possible marker or run, without a semantic role attached.
- **Witness family:** a group of correlated observations that supplies one
  independent kind of evidence.
- **Resolution:** the role assigned to a marker level in a local run.
- **Materialization:** projection of resolved roles into the existing
  structure graph and PDF product.

Sequence detection answers "which marks belong together?" Resolution answers
"what does this run mean here?" Those are separate questions.

## Governing principles

### 1. Compose primitives before adding heuristics

Before any implementation change, record every existing primitive used by the
PDF classifier, pairer, structure grammar, and extraction layer. A new
primitive is justified only if the required fact is absent. A new regex that
approximates an existing typed result is a regression in design.

The painted/raster note-band separator is the model example. It should be
consumed directly. A second "near the bottom of the page" approximation would
be worse.

### 2. Do not double-count correlated evidence

Witnesses are independent by family, not by field count:

- rooted, consecutive, and gapless are one sequence family;
- bold, large, and title case are one presentation family;
- small font, lower-page location, and the inferred note region are largely
  one note-layout family;
- citation presence and citation density are one citation family;
- `heading` plus the typography used to infer it are not two witnesses.

The note-band separator needs particular care. The physical painted rule is
independent geometry, but the native-PDF selector already prefers a rule near
a small note label. The resulting separator and that label's typography may
not be counted as wholly independent proofs. The raster separator is likewise
a geometric primitive whose classifier provenance must be retained.

No general provenance framework is needed. A small, fixed mapping from each
primitive to its witness family is sufficient.

### 3. Direct relations outrank circumstantial patterns

An actual reference/body pair, explicit source region, validated table cell,
or page-label sequence is stronger than a style resemblance. Direct evidence
can establish a role by itself when the underlying detector already passed
its own validation. Circumstantial recovery normally requires two independent
witness families and no incompatible direct evidence.

Native PDF tags are claims, not automatically truth. They remain strong only
when their range and source identity validate.

### 4. Absence is usually neutral

No citation does not mean "not a note." No bold font does not mean "not a
heading." A numbered run starting late does not mean "not paragraphs."

Negative evidence is a veto only when the structures are logically
incompatible at the same marker or range: a proven folio is not a paragraph
number; a table cell coordinate is not a document section start; a paired
note-label token is not also the document's numbered paragraph token.

### 5. Distinguish conflict from containment

Many legal structures overlap legitimately:

| Combination | Relationship |
| --- | --- |
| Page with any content structure | Orthogonal overlap |
| Section with numbered paragraphs or lists | Contains |
| Numbered paragraph with a subordinate list | Contains |
| Heading with the section it opens | Same anchor, compatible |
| Paragraph or section with a footnote reference | Related, not overlapping bodies |
| Note body with citations | Contains |
| Navigation row with a citation | Contains |
| Same marker as note and paragraph/section/list | Conflict |
| Same row as navigation and body section/paragraph | Conflict |
| Proven furniture or folio with content role | Conflict |
| Proven table cell with document-level promotion | Conflict |

Resolution applies to a marker level in a local run, not to an entire
document or even necessarily an entire range. A section may contain a running
paragraph spine and nested list levels without contradiction.

### 6. Resolve locally, never by document genre

Do not branch on filename, corpus label, jurisdiction, or document type. A
factum may contain quoted legislation, a schedule, a list, a transcript
excerpt, and ordinary numbered submissions. Each uninterrupted local flow is
resolved from its own evidence.

Local scopes begin and end at proven structural resets such as headings,
columns, note regions, tables, forms, appendices, schedules, opinion changes,
and material geometry changes. Page boundaries do not end a run when flow and
sequence continue across them.

### 7. Treat restarts as scoped evidence

A new `1` can open a judgment, opinion, schedule, appendix, note stream,
section, list, or quoted excerpt. It is not automatically a document-level
restart or an error. Existing structural-reset headings, note restart modes,
container hierarchy, geometry, and surrounding flow determine the scope.

### 8. Grammar identifies shape before meaning

The existing numeric and hierarchical grammars identify marker families and
parentage. They do not alone decide whether `1`, `1.1`, `(a)`, or `(i)` means
a paragraph, provision, list item, transcript line, note, or navigation row.

Explicit words such as `Part`, `Article`, `Section`, and `Schedule`, coherent
heading ladders, parent/child nesting, and heading-to-body transitions support
provisions. Rooted integer sequences attached to continuing prose support
numbered paragraphs. Consistent subordinate indentation and sibling shape
support lists. Genuine ambiguity must abstain rather than manufacture a legal
level.

### 9. Use local baselines, not absolute presentation values

Font size, indentation, line width, gaps, and page position are relative to
the local body and column. The existing body-font medians, page dimensions,
column models, note-column fits, and band geometry already provide these
baselines. Do not add document-specific point sizes or pixel thresholds.

### 10. Document topology is a weak, scaled witness

Position is measured within substantive body flow after proven covers,
furniture, tables, and excluded regions, not by raw PDF page number.

Topology considers both start position and run coverage. A long run spanning
most of a two-page PDF must not be penalized as "late." A compact run confined
to the tail of a long work can support endnote or index interpretations. This
witness never resolves a role alone and becomes neutral when the document or
candidate span is too short to make relative position informative.

### 11. Preserve existing accepted output asymmetrically

New recovered structure needs positive proof. Existing accepted structure is
changed only by a direct incompatibility or by at least two independent
contrary families. This protects heading, page-label, table, and footnote
metrics while still allowing demonstrated false positives to be removed.

Ambiguous recovery leaves the text and physical prose boundaries untouched
and emits no synthetic legal locator. Physical prose paragraph ordinals are
not numbered legal paragraphs.

### 12. Keep the evidence flow acyclic

Mutual reinforcement does not require repeated rescoring. The production flow
is a directed sequence:

```text
extracted lines, spans, geometry, rules, and source roles
    -> existing furniture/table/page/column/heading/note-region primitives
    -> raw local marker runs
    -> safe pre-pairing exclusions and suppressions
    -> footnote/endnote pairing once
    -> final run-role resolution once
    -> structure graph, paragraphs, sections, lists, notes, and propositions
```

Strong non-note runs may set the existing `suppress_footnote_label` control
before pairing. Pairing results then settle or oppose final note/body roles.
Final paragraph boundaries improve proposition context, but no downstream
product is fed back into an earlier detector.

### 13. Abstention is a valid universal result

Universal means the same evidence rules work across legal PDF families; it
does not mean every number receives a guessed semantic label. When competing
proofs remain unresolved, retain page and exact-text addressing and report the
ambiguity. False precision is worse than an honest missing locator.

### 14. Every new rule must describe an invariant

No rule may mention a corpus filename, publisher, template, or one-off
document type. It must explain a reusable legal/document invariant and win on
held-out source families. A unique exception is acceptable only when it fixes
a logically impossible assignment, not merely a disliked corpus output.

### 15. Scan once and retain compact receipts

Per-line font size, marker parses, citation spans, body offsets, and geometry
summaries are computed once and indexed by line ID. The resolver does not
rejoin and rescan the document for every role.

Each changed heuristic node retains only a rule code and the small typed
observations that authorized it. Do not serialize a feature dump or build a
configurable scoring framework.

### 16. Never let a run certify itself

A hash is evidence only when it is compared with an independent accepted
product, human truth, or a source-to-product invariant. Hashing a candidate,
then rerunning the same candidate against that hash, proves only determinism
and is not a release gate. One fresh corpus execution produces correctness,
regression, attribution, and timing receipts together. Repeat the full corpus
only after a real defect is fixed or an independent baseline changes.

### 17. Structure never repairs source order silently

Reading order is an upstream fact with its own column, geometry, hyphen-flow,
and regression checks. A structure sequence may expose a likely ordering
fault, but the resolver may not reorder lines merely to make a ladder clean.
It either consumes the accepted order or abstains with the existing flow/order
diagnostic. This prevents a semantic detector from changing source text to
validate itself.

### 18. Evidence quality limits inference, not source preservation

Low text quality, missing geometry, uncertain columns, or an ambiguous raster
separator reduce the claims that may be recovered. They never discard source
text or erase a validated native claim. Strong inference requires stronger
corroboration as observations degrade; otherwise the engine keeps page/text
addressing and abstains.

## Existing primitive inventory

The implementation pass begins by turning this canvass into a checked list.
The following primitives already exist and are expected to be reused.

### Extraction and page geometry

- line, word, and span bounding boxes;
- font name, size, flags, and superscript state;
- source block index and reading order;
- page dimensions, source, and text quality;
- painted horizontal-rule note separators from digital-born PDFs;
- raster horizontal-rule separators from OCR, including two-column and
  ambiguous status at the detector boundary;
- PDF/provider source regions when available.

### Page, furniture, and flow

- normalized repeated-furniture clusters with alignment and parity handling;
- alternating folio sequences;
- printed page-label selection and ambiguity diagnostics;
- single-, two-, and margin-column models;
- column-aware reading-order arbitration;
- geometry order, column switches, vertical regressions, and hyphen-join
  coherence;
- text-flow boundary faults and dangling-soft-hyphen diagnostics;
- drop-cap repair.

### Heading and hierarchy

- enumerator interpretations and the existing heading-ladder parser;
- source-role eligibility;
- all-caps, title-case, bold-character share, body-font baseline, and style
  corroboration;
- sentence completion, bracket balance, body-flow edges, and bilateral body
  geometry;
- wrapped-heading continuation;
- citation/destination-shaped heading rejection;
- explicit structural reset headings;
- current false-heading demotion.

### Notes and references

- the per-page note-band separator;
- label typography relative to body size;
- lower-page, margin-column, and two-column note models;
- table-note distinction;
- endnote headings, continuation pages, expected next label, and restart
  sequences;
- detached, spliced, isolated-inline, and native superscript references;
- note zones, protected citation spans, outline spans, note-column fit,
  small-font state, prose-likeness, and region-witness demotion;
- reference-supported candidate flags, parenthetical-reference flags, and
  volume-split protection;
- backbone selection, segment selection, gap repair, out-of-order recovery,
  missing-reference repair, same-value runs, repeated references, and
  label-only support;
- paired note confidence, proposition attachment, unresolved-reference
  diagnostics, and note cross-references.

### Tables, forms, and navigation-like regions

- strong table evidence, captions, row/cell alignment, and continuation;
- table-cell and table-note membership;
- contents-grid detection;
- region roles for tables, images, figures, charts, formulas, separators, and
  other visual material;
- `exclude_from_body` as the existing exact-range exclusion mechanism.

### Format-neutral structure and citations

- raw case, legislation, instrument, journal, and native-markup grammars;
- rooted and footnote numeric-sequence selection;
- hierarchical section labels and parent labels;
- native claims, coverage, exclusions, and paragraph breaks in the existing
  structure evidence model;
- protected citation spans, citation cues, continuation cues, reporter
  inventory, and boolean citation signals;
- the shared legal grammar corpus, including the newer US families.

The code review must also identify primitives that are currently private but
need a typed summary. Exposing a summary is preferable to copying the detector.

## Composite-witness lineage

Several valuable existing primitives already combine lower-level evidence.
The resolver should consume their result and provenance without pretending
that the ingredients are additional independent witnesses.

| Composite primitive | Existing ingredients | Independence rule |
| --- | --- | --- |
| Native PDF note-band cut | painted rule, page-relative geometry, nearby small label when present | Count as band/region evidence; do not count its selecting label and size again as separate proof |
| Raster note separator | horizontal/vertical rule classifier and ambiguity result | Count as band geometry only when accepted; ambiguous status supplies no positive proof |
| Inferred note region/mode | band cut, label run, body-size ratio, page position, columns, endnote continuation | One band/region family result; an actual external reference pair remains independently relational |
| Paired note | label backbone, reference candidates, protected spans, repairs, region evidence | The accepted reference/body relation is direct proof; its internal label/sequence score is not extra proof |
| Accepted heading | source role, enumerator ladder, typography, flow, citation and destination vetoes | One accepted heading claim; only genuinely separate hierarchy or containment facts may corroborate it |
| Printed page label | edge role, label grammar, per-page selection, ambiguity checks | One repetition/edge claim; do not add its numeric sequence as a second content-sequence witness |
| Repeated furniture/folio | normalized repetition, alignment, page parity or alternating sequence, edge geometry | One repetition/edge exclusion; identical text away from the accepted cluster remains eligible content |
| Table/table-note classification | caption/grid/alignment evidence plus note-row exceptions | Table membership is one region exclusion; table-note status remains eligible for the separate note relation |
| Citation signal/protected span | citation grammar, reporter inventory, normalization, pinpoint cues | One citation family; a successfully paired reference is separate only because it is a document relation |
| Heading ladder or outline span | enumerator interpretations, sequence state, nesting and violations | One hierarchy/sequence claim; its individual increments and rootedness do not become extra votes |

The point is not to unpack every detector into a feature graph. The fixed
lineage table prevents accidental double-counting while keeping the existing
detectors encapsulated.

## Witness families and interactions

| Family | Existing evidence | Can support | Can oppose |
| --- | --- | --- | --- |
| Sequence | marker grammar, rootedness, continuity, restarts, nesting | paragraph, provision, list, note, transcript line | isolated-number interpretations |
| Flow | body-flow edges, wrapping, hyphen continuity, paragraph-length prose | numbered paragraph, provision body | heading, navigation, note when same run continues as body |
| Hierarchy | heading ladder, explicit containers, parent labels, reset headings | section/provision, nested list | flat running paragraph at the same marker level |
| Presentation | local font/style/gaps/indentation | heading, list, note | role whose expected local presentation is contradicted |
| Band/region | note separator, note mode, margin/two-column fit, table-note region | footnote/endnote | body roles at the same range |
| Reference | superscript/detached reference and successful pair | note; proposition relation | paragraph/section/list at that label token |
| Citation | protected spans, cues, density | note or TOA when context agrees | citation-shaped heading; never ordinary prose alone |
| Navigation | contents grid, leaders/destinations when available, compact rows, valid page labels | TOC/TOA/index | body section/paragraph/list at the same rows |
| Repetition/edge | furniture clusters, alternating folios, printed labels | header/footer/folio | all content roles at the same line |
| Region exclusion | table cell, form/visual role, `exclude_from_body` | typed table/form/visual output | document-level text promotion |
| Topology | substantive-body start, end, and run coverage | weak paragraph, endnote, navigation context | nothing alone |
| Source | validated provider/PDF role | corresponding native role | heuristic override lacking stronger contrary proof |

The matrix is a constraint, not a score sheet. A family may contribute at most
one vote to a circumstantial proof, and its absence normally contributes none.

## Current code-backed ownership analysis

Three independent audits on 2026-08-22 traced the Rust core, Beaver callers,
and PDF pipeline. This section records what the code actually does; the active
execution order is in [Shared document structure](../roadmap/document-structure.md).

### Rust core

| Current surface | Actual use | Decision |
| --- | --- | --- |
| `DocumentInput` in `legal-structure/src/lib.rs:286` | Detectors consume identity/text, source kind/options, native claims, complete-role clipping, exclusions, and break positions. `units` and all geometry/layout/style fields are validation-only; `NativeClaim.provider_order` and break strength/neighbours are unused. | Keep it as the internal source-fact seam, contracted to document ID/text/source hash/scope/origins/native claims/coverage/exclusions. Move detector options to typed capability inputs. PDF geometry, DOCX styles, journal regions, and grids never become optional fields on one universal DTO. |
| `infer_graph` in `legal-structure/src/derive.rs` | Materializes provider/profile detector `Block`s, assigns IDs/parents, clips against coverage, and creates graph nodes/relations. | Delete after selected facts use the final assembler. |
| `resolve_structure_graph` in `legal-structure/src/candidates.rs` | Independently materializes PDF candidate runs, notes, lists, parents, relations, and diagnostics. Its only production semantic caller is `legal-pdf-structure/src/structure.rs`. | Delete the public generic resolver. PDF keeps its exact role decisions and emits selected facts to the same policy-free assembler. |
| `StructureGraphV2` | Duplicates parent/`Contains`, references/`FootnoteFor`, node ends/boundaries, and PDF paragraphs/notes; `Precedes` has no emitter. It cannot hold the mature definition, reference, TOC, table, proposition, provenance, and source-map products without becoming a bag. | Replace with `DocumentStructure` in one cutover, not a wrapper or compatibility alias. |
| `ScalarText` in `legal-structure/src/lib.rs` | Already owns the useful scalar/byte/UTF-16 checkpoints and line table. Other adapters/projectors repeat smaller converters. | Keep the name and implementation; move it to `text.rs`, then absorb only converters proved identical by Unicode/whitespace vectors. |
| `select_numeric_sequence` in `legal-structure/src/numeric_sequence.rs` | Has two real callers: rooted case paragraphs and PDF footnote backbone. They share a DP but differ in start, predecessor, penalty, and winner rules. | Do not make it the architecture and do not split it gratuitously. Retain unless an exact side-by-side implementation is smaller. |
| `instrument_contents_outline` in `legal-structure/src/instrument.rs` | The literal Rust port is returned by the production `deriveInstrumentStructure` operation. The TypeScript detector and standalone native export are gone. Across 124 agreements plus 748 PDFs, lineation and contents were byte-identical over 1,221,262 lines. | Keep it inside the single instrument analysis call. Preserve the locked differential whenever its lineation, whitespace, or UTF-16 machinery changes. |
| A2AJ/native-markup/journal modules | Already passed the accepted 323,374-row SourceDoc cutover. | Preserve their literal parsers/reconciliation. Change their output ownership; do not design a third adapter. |
| SourceDoc composer/projector | Uses `original_claims` and per-block field-order variants to round-trip provider blocks through graph materialization. | Keep one serializer/index/range builder and bounded format egress rules; remove canonical `SourceDocBlock -> claim -> graph -> SourceDoc` round trips. |

`CoverageState::Absent` and `Augment` are operationally identical: only
`Complete` changes inference clipping. Authority affects the owning detector,
not assembly. A2AJ legislation, for example, consumes native top-level
sections while finding children and supplements incomplete maps. Final
capability inputs therefore state exact native facts and explicit suppression
ranges; the assembler never invents generic native-versus-heuristic policy.

### Beaver and provider callers

| Current path | Repeated work / wrong ownership | Final disposition |
| --- | --- | --- |
| `legalTextSkeleton.ts` | Converts Rust sections into `AgreementSkeleton`, builds another SourceDoc, then runs TS TOC, definitions, table materialization, and a weak cross-reference summary. | Port the remaining mature detectors, return canonical facts once, and delete the skeleton representation. |
| `legalCrossReference.ts` | Re-scans references and resolves over the skeleton with real ambiguity, depth, integrity, reach, and abstention rules. | Port literally into typed provision-reference outcomes. Keep traversal/depth as consumer queries. |
| `docxStructuralLint.ts` | Reopens `word/document.xml` even though `DocxSession.document()` already owns accepted paragraph text; it also repeats number/reference/definition scans. | Reuse one session. Rust emits facts; TS retains severity, messages, excerpts, small-gap/restart policy, and output caps. |
| `sourceDoc.ts` | Mixes construction/index/range summaries with legitimate locator/range/quote queries. | Rust owns construction; keep the light TS lookup, slicing, address, token, and phrase-query functions. |
| `legalDocumentNavigator.ts` | Mostly query syntax and bounded traversal; page-marker parsing is a fallback over Beaver-rendered text. | Keep queries, not a second navigation representation. Delete the marker fallback only after caller closure. |
| A2AJ tools | Provider structure is flattened, then compiled again as an instrument skeleton and cross-reference graph. | Query the one provider structure result; never de-detect authoritative provider facts. |
| CourtListener/TNA | CourtListener may derive twice; TNA reparses markup for cited `<ref>` rows after Rust parsed it. | Select the rendition before the call; one Rust markup traversal emits text, structure, and cited-reference facts. |
| `legalStructureSidecar.ts` | Stores duplicate skeleton and cross-reference DTOs while reusing useful hashing/single-flight/atomic ideas already present in the projection layer. | Store one canonical structure through the existing application/persistence boundary and delete the structure-specific DTO/cache. |
| `legal-structure-store` + `sourceDocCache.ts` | Not dead: A2AJ local bulk runtime reads its SQLite SourceDocs. | Rebuild producer/reader together around canonical structure, preserve resume/atomic promotion, then delete the old schema/reader. Core owns no store. |
| `sourcedoc-jsonl.ts`/`sourcedoc_client.py` | AuthoritiesHelper, citator, stress, and probes cross Node/tsx; the Authorities compiler-string expectation is already mismatched. | Replace every caller with the direct Python binding, then delete rather than repair the protocol. |

`documentProjectionService.read` remains Beaver's byte/file projection host.
It already bounds and hashes inputs, opens one `DocxSession`, keeps the typed
spreadsheet grid, invokes PDF preparation, and single-flights immutable
versions. It and the existing acquired-provider adapters must call one typed
structure host after their distinct extraction/fetch steps. Do not widen the
file service with provider request variants or add a second analyzer. Keep
`documentProjection.ts` as the existing local path/lock/atomic-receipt owner;
do not pretend it is already a generic cloud projection repository.

### PDF

| Current duplication | Code-backed decision |
| --- | --- |
| `PdfTextIndex` joins every ordered raw line, while PDF SourceDoc creates page markers, cleaned paragraph text, separators, and appended notes. | These are genuinely different text planes. Keep an explicit raw-to-semantic map; never substitute one for the other. |
| One accepted note becomes `Footnote`, anchor/sentinel values, `NotePairClaim`, marker rows, graph nodes, and inverse relations. | Keep pair-search/audit state private, but emit one typed paired-note semantic fact and derive projections. |
| `marker_summary` is a clone of `pairing_summary`. | Own one summary; any duplicate legacy field is test-only serialization. |
| Protected citation spans are computed twice and `PairLine` clones line text/layout facts. | Build typed line facts once; share only the exact protection product after a 1,221,262-line differential. |
| `LegalDocument` owns pages, paragraphs, footnotes, tables, images, and graph, while SourceDoc/lookup build more semantic units. | Raw pages/tables/images remain PDF artifacts. Paragraph/note semantics live in `DocumentStructure`; source mapping/format metadata refer to node IDs. |
| Later `source_doc` and `structure_lookup` contract operations call the parser again, normally loading cache, and Beaver uses child-process JSON. | Return structure plus optional SourceDoc from the original parse and query that artifact. Delete the later parse/transport seams. |
| `build_document` withholds authoritative extracted tables/images from structure. | Pass the complete `ExtractedPdf`; add stable artifact references before claiming product parity. |

PDF keeps extraction, OCR, geometry, reading order, columns, furniture,
printed folios, headings, table/image detection, note regions, and
geometry-backed note pairing. The shared crate owns the final semantic model,
text-only capabilities actually reused outside PDF, coordinate primitives,
and SourceDoc serialization. Similar outputs do not erase this dependency
boundary.

### Dependency and repository direction

```text
legal-structure
  +-- legal-structure-node    --> Beaver
  +-- legal-structure-python  --> AuthoritiesHelper / citator / ALR

legal-pdf-parser --------> legal-structure
Beaver provider/DOCX/grid adapters --> one typed Node operation
```

`packages/legal-grammar-tables` remains the sole authored portable grammar
corpus (currently 72 entries/296 vectors). Protected spans, citation signals,
provision references, full citation parsing, and citation splitting are not
presumed to be one scanner or one crate. Share the corpus and only the exact
proved match product. No current dependency cycle justifies a separate
`legal-citations` package.

Once the final API and corpus gates pass, extract the existing
`legal-structure` directory with history into its public repository. Move the
authored grammar package unchanged if the released crate needs to own it. Do
not create a facade, copied implementation, service, plugin API, rules
language, schema crate, repository store, or compatibility package. Rust
callers link directly; Node/Python cross one in-process boundary per document,
never once per line, note, or citation.

## Cross-phase failure traps

Any row below blocks promotion; none is a “follow-up cleanup.”

| Trap | Fail-fast gate |
| --- | --- |
| A shared facade calls old PDF/TypeScript/Python detectors | Dependency/source scan must show the shared Rust implementation is the only executable owner before cutover. |
| The new core imports PDF geometry/model types | Source-boundary check rejects any dependency from `legal-structure` toward PDF, OCR, provider, product, or storage crates. |
| A generated grammar copy becomes editable source | Only the subrepository corpus is authored; packaged copies carry and verify its hash and are never test/runtime fallbacks. |
| Node/Python transport erases Rust's benefit | Fixed batch benchmarks and call counters reject per-line/per-note calls, subprocess use, or binding time that dominates parsing. |
| Scalar/UTF-16 offsets silently drift | Astral, combining-mark, CRLF, empty-range, and round-trip slicing vectors pass in Rust, Node, and Python before any consumer cutover. |
| Provider-native facts are flattened and re-inferred | Coverage/authority differential rejects loss or heuristic replacement of a native claim. |
| ALR “parity” checks mocks or aggregate counts only | Real accepted inputs, full installed provider corpora where applicable, and exact public-output diffs are mandatory. |
| An aggregate gain hides a class/source regression | Metrics are reported per structure/citation role and held-out source family; missing truth permits only parity or explicit adjudication. |
| Luna/model output is treated as native or authoritative text | Typed operation validator and source-accounting gate reject unanchored or unapproved changes before structure analysis. |
| Journal success is mistaken for ontology generality | Non-journal expressivity gate covers decisions, legislation, forms, tables, navigation, transcripts, bilingual flows, and endnotes. |
| Note pairing and reading order endorse each other circularly | The addendum accepts only order-invariant pairs and ranks existing order candidates after the main cutover. |
| Benchmark improvements come from changed denominators, caches, or resumes | Frozen manifests, fresh cache namespaces, complete failure accounting, and end-to-end wall time are part of every receipt. |
| Independent repositories ship mismatched engine/binding/grammar versions | Embedded source/grammar/schema provenance must equal every declared pin before any coordinated push. |
| Moving code is reported as deletion | Contraction counts only displaced maintained consumer code after the shared move; generated artifacts and relocated lines do not count. |
| The structure repository grows storage, retrieval, service, or plugin infrastructure | Ownership/source scan fails; those concerns remain consumers or are deleted. |

## Initial role proofs

These are the intended proof shapes. Exact thresholds remain existing detector
thresholds wherever possible and are frozen in tests before corpus tuning.

### Furniture and printed folios

Use the existing aligned repetition, alternating-folio, edge geometry, and
printed-label validators. A proven furniture/folio line is excluded from every
content role. Similar text elsewhere on the page is not excluded merely
because the string repeats.

### Table or form content

Validated table cells remain typed table content. Table notes remain eligible
for note pairing. Numeric rows inside cells never become document paragraphs
or sections. Form-like visual regions remain unpromoted unless an independent
body-flow or hierarchy proof exists outside the field/grid range.

### Navigation rows

TOC, TOA, and index candidates require navigation context plus row-shape or
destination evidence. Examples include a contents/authorities/index heading,
the existing contents grid, repeated compact rows, dotted leaders,
right-aligned locators that agree with valid printed pages, or actual PDF
destinations if later exposed by extraction.

Citation density supports a TOA only with navigation evidence. It never turns
ordinary citation-heavy argument into navigation. Accepted navigation rows
are excluded from paragraph, section, and list recovery but may be retained as
navigation structure.

Printed page labels and navigation locators interact asymmetrically: the
validated page-label stream can corroborate that right-column numbers are
destinations, but those destination rows cannot become page labels because
they are not one aligned edge label per physical page.

### Footnotes and endnotes

A successful reference/body pair is direct proof of the note relation. An
unpaired label requires independent support from note-band/region evidence and
sequence, reference, citation, or topology evidence. Citation density alone is
insufficient because legal body prose is often citation-rich.

The note-band separator is strong evidence for the range below it, subject to
the existing table-band veto and two-column handling. Tail position may
distinguish endnotes from bottom notes only when note-region or pairing
evidence already exists. Lack of citations is neutral.

An endnote heading such as `Notes` or `Endnotes` opens note scope. It may remain
a heading, but it must not also open an ordinary document section merely
because the heading detector accepted it. Conversely, a section named
`Notes` without note-region or note-sequence evidence is not enough to convert
all following prose into notes.

### Headings and sections

Existing accepted headings remain. A recovered provision requires a coherent
hierarchical/explicit locator plus either a heading-to-body transition,
consistent nesting, or corroborating presentation. The existing body-flow,
citation-shape, destination-shape, and dirty-ladder demotions continue to veto
false headings.

A section container can hold numbered paragraphs and lists. Resolver output
must therefore classify each marker level rather than label an entire
instrument run as sections.

Citation interaction is range-specific. A candidate heading that is itself a
citation or destination is opposed; citation-dense prose beneath a genuine
heading does not oppose the heading. Protected pinpoint phrases such as
`section 5` or `paragraph 12` remain citation/cross-reference spans and do not
become local section or paragraph starts.

### Real numbered paragraphs

A numbered-paragraph spine requires a rooted compatible sequence plus prose
flow at the same marker level. Cross-page continuation, broad substantive-body
coverage, and repeated body geometry can corroborate it. Simple sequence
coherence does not.

Strong note, navigation, transcript-line, table/form, or section-heading proof
at the same marker level vetoes paragraph promotion. A paragraph spine may
start after preliminary material; topology is only a weak corroborator.

The result is a logical paragraph node spanning its source lines and pages.
It does not rename geometry-backed prose regions or synthesize legal paragraph
numbers where no printed marker exists.

### Lists and nested enumerations

Lists require compatible sibling markers plus indentation/parallel layout,
parent introduction, or a coherent subordinate level. A bare root sequence of
full prose is not called a list merely because its items are short. Explicit
provision hierarchy and running-paragraph flow take their respective roles at
their own levels; subordinate `(a)`/`(i)` levels may remain lists inside them.

### Transcript and index line numbers

Dense margin-aligned numbers that restart per page, advance at line cadence,
and coexist with speaker/time/dialogue patterns are line-number or index
evidence, not paragraphs or sections. This is a local layout invariant, not a
`document_type == transcript` branch. Genuine paragraph markers inside the
same PDF remain recoverable when their geometry and cadence differ.

Per-page restart cadence and stable margin position form one transcript-line
layout family, not two votes. Speaker/time patterns are separate textual-flow
corroboration.

### Ambiguous runs

If incompatible roles each have circumstantial proof and neither has direct
evidence, abstain. Preserve exact text, pages, physical prose boundaries, and
diagnostics. Do not expose an invented legal locator.

## Retained witness-resolution requirements, proved first in PDF

The witness principles above are not PDF principles. DOCX styles/numbering,
provider roles, OCR regions, and plain-text flow may also need multiple typed
facts before assigning a semantic role. What is PDF-specific is the current
public implementation: `CandidateEvidenceV2` requires page/line IDs, all nine
observations are computed from PDF facts, and its veto rules would be wrong
for authoritative markup or native DOCX lists. Preserve the method, not that
false boundary.

Each owning detector may use compact private candidates and witness-family
summaries. Extract shared resolution code only after a second real caller has
the same candidate, evidence-family, role, incompatibility, and abstention
semantics and the extraction deletes duplicated code. Missing evidence is
neutral; raw geometry/styles/provider payloads never enter a generic bag.

### 1. Freeze the baseline and primitive map

- Keep the frozen SourceDoc parity receipts immutable and do not repurpose
  their scripts as a corpus runner.
- Record the current 748-document PDF products, independently protected-field hashes,
  per-class counts, runtime, and existing footnote/heading/page/table metrics.
- Complete the primitive inventory above with code owners and evidence-family
  lineage, especially composite primitives such as note regions and note-band
  selection.
- Create a compact adjudicated run set from distinct disagreement/failure
  classes. Split holdout by source/template family, not random pages.

### 2. Expose raw candidates, not pre-labelled sections

- Reuse the format-neutral marker and hierarchy grammars.
- Return typed local runs with marker ranges, labels, levels, and parents.
- Map candidates to existing page/line IDs once.
- Remove the universal post-hoc `instrument` section assignment rather than
  wrapping it in another adapter.

### 3. Keep witness resolution beside the owning capability

- Assemble compact witness-family summaries from existing PDF primitives in
  `legal-pdf-structure`.
- Apply only direct exclusions and strongly proven non-note suppressions before
  pairing.
- Pair notes once with the canonical Rust pairer.
- Resolve each PDF marker level once using the principles and proofs above;
  initially keep that policy private to the PDF capability because it has no
  second semantically identical caller.
- Preserve one rule code and the authorizing typed observations for every
  changed heuristic result.
- If a non-PDF capability later proves the same decision table, move only that
  exact table and its small typed summary into shared Rust. Do not make the PDF
  enum the universal vocabulary.

The target is a few hundred lines of orchestration. A generalized rule engine,
configuration language, plugin system, iterative optimizer, or second graph is
out of scope.

### 4. Materialize through the final structure

- Preserve physical pages and prose paragraphs.
- Add real numbered-paragraph, section/provision, list, navigation, footnote,
  and endnote nodes only when proven.
- Preserve heading levels, page labels, source line IDs, footnote pairs,
  propositions, and containment/reference relations.
- Emit selected facts and irreducible relations to the one policy-free
  `DocumentStructure` assembler rather than a PDF-only parallel result shape.

### 5. Corpus qualification

The release gate is the complete registered corpus, never a sample standing
in for it. A single fresh run must emit all qualification evidence; no
candidate-generated baseline pass followed by a ceremonial comparison pass.

- 748/748 documents and 24,707/24,707 pages complete.
- Wall time is at most 180 seconds on the established machine and protocol.
- Source text, character order, page identity, line identity, and geometry have
  zero unintended differences. Derived legal structure is expected to change:
  numbered paragraphs, provisions, lists, navigation, notes/endnotes, and
  rejected false positives are the purpose of this phase.
- Printed page labels, tables/forms, reading order, current heading grammar,
  and footnote/proposition products do not regress.
- Paragraph, section/provision, list, note, navigation, heading, folio, and
  table/form metrics are reported separately, including false positives,
  false negatives, and abstentions.
- Every changed run is attributable to a named proof rule.
- New complexity is accepted only for a recurring failure class with a win on
  held-out source families.

The historical 1,024-journal note scores remain a qualification floor once
their exact inputs are restored: label precision `0.955722`, recall `0.975931`,
F1 `0.954846`, and reference-page F1 `0.944823`. They are not currently a
runnable release gate. Phase 1 uses the runnable 661-page truth surface plus
the canonical 100-article/6,740-marker pairing surface; the latter is an
implementation receipt, not a substitute for human accuracy.

## Retained shared citation/structure requirements

Consolidation must not quietly tune structure and citations at the same time.

### 2.1 Freeze the reference surfaces

Record immutable inputs, outputs, versions, and compact hashes for:

- the current `legal-structure` Rust provider/SourceDoc corpus receipts;
- the complete Phase 1 PDF output and per-structure metrics;
- the authored grammar corpus and all positive/negative vectors;
- backend citation spans and lookup keys;
- DOCX citation partitions, fields, quotes, and hyperlink plans;
- AuthoritiesHelper parsed authorities and occurrence ranges; and
- ALR's citation parts, quote results, proposition spans, A2AJ/CourtListener
  SourceDocs, exact links, and checked-workbook outputs.

The old code is an oracle only while the new repository is being proved. Do
not regenerate a frozen oracle after extraction starts, teach the candidate to
call the oracle, or retain either implementation as a shipping fallback.

### 2.2 Characterize citation products before sharing scans

The authored grammar corpus, corrected Canadian/UK/US inventories,
deterministic splitter, and ALR behavior are shared source material. They do
not prove that every citation-shaped product is one scan. The current products
have materially different contracts:

| Product | Required result |
| --- | --- |
| PDF protected spans | Exact negative guard ranges used by heading/note detectors; conservative overlap behavior is load-bearing. |
| Citation signal/density | A bounded structural witness. Counts and thresholds matter; full identity fields may not. |
| Provision references | Intra-document target syntax, owning-instrument context, ambiguity, reach/integrity refusal, and resolution reasons. |
| Full legal citations | Reporter/family identity, normalized lookup key, pinpoints, overlap choice, and surface ranges. |
| ALR/DOCX citation splitting | Lossless authority-part boundaries, fields, attached quote/pinpoint/reference signals, and ordered supra/ibid context. |

Before merging two scans, compare their text plane, accepted ranges, boundary
rules, overlap policy, context/state, and consumers over the union of their
vectors. Share the authored grammar entry or the exact lower-level span scan
when that comparison passes. Otherwise keep the products distinct. Do not
invent a `CitationDocument` mega-result merely to make them look unified.

The eventual shared Rust capability may expose more than one operation. It
must still batch documents/notes, reuse an exact shared scan where one exists,
and never cross Node/Python once per note or citation. Ordered prior citation
context is explicit so supra/ibid behavior cannot depend on hidden global
state. Every split accounts for every input character and reports complete,
partial, or abstain.

Provider lookup, authority identity confirmation, network calls, URL choice,
DOCX mutation, TOA grouping, workbook policy, review UI, and rendering remain
consumer/product work. A provider result may confirm or enrich a parsed
identity; it may not create a citation boundary retroactively.

Canonical Rust/result offsets are Unicode scalars. Detector internals may use
typed UTF-8 byte ranges for exact slicing through the existing `ScalarText`
boundary table; Node egress emits explicitly labelled UTF-16 offsets and
Python uses Unicode-scalar/code-point offsets. Astral characters, combining
marks, CRLF, and normalization are differential vectors. Normalization is
comparison metadata only and never changes surface text or source ranges.

### 2.3 Keep format-neutral detection in one engine without one mega-ingress

The `legal-structure` crate owns the final `DocumentStructure`, scalar-offset
accounting, format-neutral grammars/detectors, internal role resolution,
SourceDoc construction, and the literal A2AJ, native-markup, and journal
adapters already proved by the provider cutover.

It does not expose the current `StructureEvidenceV1`/`DocumentInput`-style bag
of optional units, geometry, styles, layouts, claims, coverage, exclusions,
and profiles. Each source adapter supplies the small native facts its detector
actually consumes. PDF geometry, DOCX styles, journal regions, and spreadsheet
cells retain typed owners rather than becoming nullable fields on a universal
DTO.

Candidate shape and semantic role remain different operations. Format-neutral
marker/hierarchy grammars may emit local candidates. A small internal
witness-family summary may be shared by PDF, DOCX, plain text, and OCR when
they genuinely make the same role decision. It carries accepted primitive
claims such as body flow, hierarchy, direct note pairing, navigation, or a
proven exclusion; it never carries raw bounding boxes or a feature dump. An
adapter with authoritative provider structure emits a direct source claim and
does not manufacture circumstantial witnesses. Missing families are neutral.

An owning capability's resolver applies the relevant fixed independence,
incompatibility, containment, authority, and abstention rules recorded above.
Source-specific code computes
facts such as columns, typography, note bands, table membership, printed
folios, Word style/numbering, or provider tags; the resolver never recreates
those facts from flattened text. A detector with genuinely domain-specific
selection policy may resolve its own role and submit the selected fact. Shared
resolution is admitted only when at least two callers have the same candidate,
witness, role, and refusal semantics and the extraction deletes duplicated
logic.

One policy-free assembler then validates ranges/anchors, assigns stable IDs
and order, resolves declared parents, checks containment/cycles/authority
conflicts, and exact-deduplicates selected facts. It does not score candidates,
pair notes, scan text, or choose native versus inferred output. SourceDoc is an
optional projection of the resulting structure, not a second detector.

The journal contract remains literal: `pages.jsonl` contributes only its
exported facts, while plaintext is split only at standalone printed
`[page <label>]` markers and emits pages only. The shared engine must not infer
journal paragraphs or other structure from that plaintext adapter.

The public boundary remains one typed operation returning structure and
optional SourceDoc. Rust/PDF callers link directly; Node and Python callers
cross their binding once per document. Candidates, witness summaries, and
resolver choreography are private Rust implementation details, not a wire
protocol.

### 2.4 Harvest ALR's reference behavior without importing the product

ALR Quote Verifier is the reference implementation for several primitives.
Classify each one before moving code:

| ALR behavior | Shared destination | What remains in ALR |
| --- | --- | --- |
| Deterministic citation splitting, field extraction, quote/pinpoint attachment, supra/ibid syntax | shared Rust citation capability after its product differential | Product mode choice and presentation of unresolved parts. |
| A2AJ and CourtListener native/flat structure composition | existing `legal-structure` adapters and same-kind supplementation | Provider credentials, fetch/cache, identity lock, rate policy, and URL choice. |
| Numbered paragraph/section detection and exact locator ranges | `legal-structure` | Selection of which provider document to inspect. |
| Reference-to-note and note-to-proposition boundaries | shared graph relations | Workbook columns, review policy, and prose shown to the user. |
| Format-neutral quote-span extraction, exact source matching, boundary refusal, and locator projection | shared deterministic evidence helpers in `legal-structure` | Deciding which authority is trusted, remote retrieval, status wording, and workbook workflow. |
| PDF extraction, geometry, note regions, and note pairing | canonical `legal-pdf-parser` | ALR's intake orchestration and error presentation. |

For each row, first determine whether the current Rust code is already an exact
port of ALR. If yes, preserve it and prove the differential. If ALR is better,
port only the missing behavior with its fixtures and provenance. If behavior
is product policy, leave it in ALR. Do not mechanically move the monolithic ALR
workflow into the neutral repository.

### 2.5 Bindings and release provenance

- Rust/PDF callers link the crates directly; this is the corpus-speed path.
- The Node binding accepts and returns the one document operation in process.
  It contains no grammar, caching, retry, or provider code and exposes no
  candidate/witness protocol.
- The Python binding exposes the same batch operations through a platform
  wheel that PyInstaller can bundle. It contains no Python fallback parser.
- Each binding reports engine commit, grammar hash, schema version, enabled
  capabilities, and binding version. A consumer fails closed on an incompatible
  schema or missing capability.
- Beaver, PDF, AuthoritiesHelper, and ALR pin a released artifact from the same
  source commit. Local development may use the checked-out subrepository, but
  the release gate verifies embedded provenance against the declared pin.

This replaces manual ports with ordinary dependency updates. A citation or
structure improvement is authored and tested once in the shared Rust package,
then consumer contract suites exercise that same build. Generated bindings
and packaged binaries are artifacts, not maintained alternate implementations.

### Shared citation/structure qualification

- Existing `legal-structure` unit and SourceDoc/provider tests pass from the new
  repository with exact frozen output.
- The full 323,374-row A2AJ/CourtListener/journal SourceDoc corpus retains its
  accepted contract; frozen receipts are read, not regenerated.
- All citation spans, lookup keys, overlap decisions, and protected ranges pass
  the Rust/PDF, backend, DOCX, Authorities, Canadian, UK, expanded US, and ALR
  vectors.
- Every grammar entry retains its source, licence, jurisdiction/family, and
  positive/negative vectors; reconciling duplicate tables cannot silently
  broaden a reporter token.
- The accepted 405-row ALR split gold has zero character loss and no regression
  in exact/acceptable partitions, field precision, or identity locks.
- Phase 1's complete 748-document PDF corpus is rerun to expose citation-caused
  structure deltas and remains at or below 180 seconds end to end.
- Rust corpus callers make no Node/Python/JSON/process round trip. Node and
  Python batch timings demonstrate that transport does not dominate parsing.
- Every old Rust, TypeScript, Python, and data copy has an explicit deletion
  target. Phase 2 is not complete while two maintained grammars or detectors
  remain.

## Retained Phase 3: OCR and bounded repair evidence

References to Codex below identify the historical Text-Fidelity oracle. The
active plan assigns the bounded repair-producer role to Luna while preserving
the same anchored-operation and deterministic-validation requirements.

This phase operationalizes the relevant parts of
`experiments/legal_pdf_corpus/LEGAL_PDF_SILVER_MASTER_PLAN.md`. That document
remains authoritative for acquisition, OCR model selection, silver production,
distillation, and the broader 1,500-PDF program. This phase defines only the
shared-engine seam and the proof order.

The existing Text-Fidelity system is valuable: it already preserves page/line
anchors, handles journal layouts, pairs notes, records repair provenance, and
routes difficult order/region cases. The problem is that its contracts and
prompts reflect the law-journal job for which it was built. Preserve the
algorithms; replace the journal-shaped output boundary.

Production ownership is explicit. PDF/OCR extraction, deterministic regioning,
and validation of visual repair operations live with `legal-pdf-parser`'s OCR
capability. The shared Rust engine owns only its internal witness vocabulary,
role resolution, and final structure. Beaver or another host invokes an
authorized model through its existing provider-neutral runtime operation;
neither Rust core imports Luna/a model SDK nor exposes a universal evidence
wire format. Text-Fidelity remains the reference/oracle until this vertical
slice passes, not a hidden production checkout.

### 3.1 Freeze the current journal lane

- Pin the exact Text-Fidelity source revision, model/runtime identities,
  prompts, ontology tables, and 661-page ordered manual surface.
- Materialize compact before-results for transcription, line coverage/order,
  regions, paragraph breaks, headings, notes, note pairs, page furniture, and
  source-anchor accounting.
- Keep existing journal final contracts immutable. An adapter experiment reads
  them; it does not rewrite them into new training truth.
- Inventory every journal-specific field and every downstream consumer before
  declaring it generic, redundant, or obsolete.

### 3.2 Materialize bounded repairs into the existing typed source lane

Map existing outputs as follows:

| Existing repair fact | Owning typed shape |
| --- | --- |
| page, region, line, word/span identity and geometry | existing PDF/OCR objects with stable IDs, source order, geometry, and origin |
| OCR/source text quality | page/line quality facts and diagnostics; never an implicit authority promotion |
| region classification and membership | existing typed region result plus member line IDs |
| line order/flow proposal | existing typed order candidate; accepted reading order remains a source fact |
| unnumbered prose boundary | selected boundary fact; never a synthetic numbered paragraph |
| source-authored page/heading/section/note fact | direct source claim with explicit range/authority |
| model/detector heading, note, table, or list guess | typed proposal with model/detector origin; never a source claim |
| accepted keep/retype/retag/reorder/split/merge/suppress result | validated PDF/OCR replacement fact with before/after hashes and producer provenance |
| unusable or contradictory area | explicit abstention/diagnostic; exact source anchors remain present |

Run a field-by-field fit test against the existing PDF/OCR types before adding
one. The model-facing repair request/response is a separate, typed producer
contract: it references immutable anchors and returns proposed operations. A
deterministic validator either rejects those operations or materializes their
effects into the ordinary PDF/OCR facts consumed by the detector lane.
`legal-structure` never interprets free-form model instructions. If an accepted
relation or proposal still cannot be represented without lying about
authority, add the smallest typed source fact required. Do not reintroduce the
discarded all-formats evidence DTO or mislabel a Luna/model proposal as native.

The data flow is fixed:

```text
source page + immutable anchors
  -> OCR/extraction candidates
  -> deterministic layout/structure proposals
  -> bounded repair request/response for unresolved cases
  -> deterministic operation validation and materialization
  -> ordinary typed PDF/OCR facts + source-accounting validation
  -> internal shared witness summaries where role semantics match
  -> selected facts -> DocumentStructure
  -> optional SourceDoc and PDF projections
```

OCR and Luna never emit a competing final SourceDoc. A Luna response is not an
accepted fact until the deterministic validator anchors it. The shared engine
remains the only place that resolves compatible source-neutral role evidence
and assembles the final structure; PDF-specific extraction decisions stay in
their typed owner.

### 3.3 Generalize the repair contract, not the detector count

- Replace journal-only output labels with the shared roles, attributes, and
  relations. Keep origin/model identity separate from semantic role.
- Preserve unknown and mixed regions. A body fallback must not erase forms,
  tables, figures/captions, TOCs/indexes, transcripts, marginalia, bilingual
  flows, endnotes, or nested legal provisions.
- Keep prose paragraph breaks distinct from numbered legal paragraph claims.
- Give the worker the existing deterministic candidates, citation spans,
  note-pair evidence, separator evidence, and neighboring-page/document state;
  do not ask it to rediscover facts already known.
- Require every repair to reference existing anchors. OCR text may change only
  through an explicit visual repair operation; digital-native text is immutable.
- Run deterministic document reconciliation first for furniture, page labels,
  sequences, hierarchy, note restarts/pairs, and cross-page continuations.
  Escalate only unresolved contradictions.
- Keep model selection outside the ontology. The Luna route is a
  repair producer, not a semantic class or permanent provider dependency.

The initial implementation should be an adapter plus prompt/schema revision,
not a rewrite of the OCR, PPDoc/Kraken, region postprocessing, footnote, or
ordering machinery. A new model or detector is admitted only for a measured
missing evidence class after the adapter proof.

### 3.4 Phase 3 qualification

Run gates in increasing breadth:

1. **Adapter conservation:** current journal contracts round-trip into shared
   evidence with exact text, page, line, geometry, order, and note-pair IDs.
2. **Journal regression:** all 661 ordered manual pages retain or improve each
   separately reported metric; no aggregate can hide a structure-class loss.
3. **Ontology expressivity:** the legal-generalization, Canadian structure,
   USLM, bilingual, form/table, TOC/index, transcript, decision, legislation,
   and endnote cases can be represented without a journal document-type branch.
4. **OCR diversity:** run the registered OCR benchmark pages across clean,
   historical, noisy, rotated, columnar, mixed, and image-dominant inputs;
   report transcription, coverage, ordering, structure, runtime, and memory.
5. **Shared-engine effects:** rerun deterministic PDF/provider/DOCX gates so a
   schema or resolver change cannot regress already-good native documents.
6. **Held-out repair:** only after the above, run an explicitly authorized,
   metered Luna repair experiment on source/template-held-out cases. Compare
   against the unchanged deterministic lane and preserve partial results.

Promotion requires complete anchor accounting, no unexplained text loss or
duplication, acyclic order, valid relations, coherent sequence state, stable
provenance hashes, and per-class non-regression. The three-minute target remains
the deterministic 748-document digital-born run; OCR/Luna has a separate
hardware/profile throughput receipt and cannot be hidden inside that number.

## Retained Phase 4: consumer cutover, ALR parity, and deletion

### 4.1 Cut over in dependency order

1. Tag the proved `legal-structure` source and build all bindings from that
   commit.
2. Point `legal-pdf-parser` at the Rust crates, remove its nested format-neutral
   crates/data, and rerun the full PDF gate.
3. Point Beaver/backend and DOCX citation linking at the in-process Node/Rust
   APIs; delete `citationKey.ts` and other superseded detection code.
4. Point AuthoritiesHelper at the Python citation batches; retain only TOA
   product behavior and Word/document handling.
5. Point ALR at the Python structure/citation/evidence APIs and the canonical
   PDF parser; delete its displaced splitter, grammar, A2AJ/CourtListener
   structure, and vendored PDF copies.
6. Update `.gitmodules`, `subrepos.lock.json`, local-subrepository docs, release
   provenance checks, and the master architecture decision together.
7. Run every consumer's integration/release gates, then commit each independent
   repository and finally the Beaver gitlinks/pins. Do not push a partial set of
   mutually incompatible pins.

There is no dual-production period, compatibility alias, legacy DTO, fallback
parser, or feature flag. Git and the frozen receipts are rollback.

### 4.2 ALR no-regression contract

ALR remains an independent product and the principal end-to-end reference.
Freeze and compare these public outcomes:

| Surface | Required proof |
| --- | --- |
| Citation splitting | Accepted 405-row manual gold plus known failures: exact/accepted partitions, exact source coverage, kinds, fields, pinpoints, quotes, supra/ibid chains, and abstentions. |
| Quote verification | Existing quote-fragment tests and real checked inputs: authority lock, match status, exact matched range, boundary refusal, pinpoint/fragment link, and no cross-paragraph false match. |
| Proposition grabbing | DOCX and PDF note/reference cases: exact proposition text/range/order, correct containing numbered/prose unit, and no leakage across headings, paragraphs, notes, or prior references. |
| A2AJ structure | Full installed A2AJ SourceDoc differential with exact text, block kinds/ranges/labels/origins, indexes, and public anchors. |
| CourtListener structure | Full installed CourtListener native/hybrid/flat differential, preserving provider markup facts and exact fallback behavior. |
| PDF intake | Representative ALR PDFs through the canonical parser: pages, paragraphs, numbered units, notes/pairs, propositions, citations, and diagnostics. |
| Product output | Real DOCX inputs and checked workbooks: row identity/order, links, quote statuses, review fields, and final workbook contents. |
| Packaging | Public and internal PyInstaller builds load the pinned native wheel offline and contain no forbidden/private assets or Python fallback parser. |

“Same or better” is intentionally strict:

- a previously correct row must remain exact unless an independently
  adjudicated fixture proves the new output better;
- every intended delta is listed by stable input ID and reason;
- on a slice with independent truth, no citation, quote, proposition,
  structure, provider, language, or document slice may lose precision or
  recall behind an aggregate gain; where truth is absent, require exact parity
  or adjudicate every delta rather than claiming improvement;
- no source character, locator, pair, or review row disappears silently; and
- on the fixed offline benchmark, at least seven alternating fresh-process
  runs keep median and p95 end-to-end time inside the larger of 5% or the
  baseline noise envelope, and peak memory stays within the recorded
  native-artifact allowance, with one native batch call per document/job
  rather than per unit.

Once this matrix passes, ALR's local copies are deleted in the same refactor.
Future citation/structure changes land in the shared repository and run ALR's
contract suite against the candidate artifact; nobody manually ports the
algorithm again.

### 4.3 Beaver and cross-product integration

- Exercise PDF ingestion, durable artifacts, and exact structure lookup in
  both account-free local and cloud persistence compositions.
- Exercise DOCX citation linking, Authorities/TOA generation, and ALR against
  the same citation grammar hash and engine commit.
- Run the 748-document PDF lane, complete SourceDoc provider corpus, available
  DOCX corpus, Authorities fixtures, and ALR end-to-end reference inputs.
- Run the repository release checks from `AGENTS.md` and each subrepository's
  own release suite.
- Verify long runs report progress, preserve usable partial results, and leave
  only compact receipts; raw corpus products remain ignored/disposable.
- Delete the rejected post-hoc PDF append, obsolete TypeScript/Python/Rust
  implementations, one-off audit scripts, and stale maintained experiment
  machinery whose findings are now covered by durable tests/results.

## Addendum after Phase 4: paired-note-guided reading-order experiment

This is deliberately outside the main cutover. Reading order is upstream of
most structure, and changing it can corrupt otherwise correct text. First ship
the shared backbone and prove all existing order metrics. Then recover the
original Text-Fidelity experiment and test one narrow proposition: a
high-confidence reference/body pair can break a tie between already-generated
local reading-order hypotheses.

### Admissible use

- The existing geometry/column arbiter must report two or more plausible local
  orders or `COLUMN_ORDER_UNCERTAIN`. Do not touch a high-confidence order.
- Candidate permutations come from the existing arbiter. Note evidence may
  rank those candidates; it may not invent a new permutation.
- Only pairs invariant across all candidate orders are admissible, preventing
  the circular rule “the chosen order created the pair that chose the order.”
- A main-text reference must precede its paired note body; bodies must respect
  the accepted note-label backbone and remain in their note flow/band. These
  are constraints, not a blanket “notes go last” rule.
- Only same-page footnote relations may vote. Endnotes and cross-page note
  continuations remain adversarial controls: their long-range relation cannot
  choose a local page order.
- The decision is page/local-flow scoped. It cannot reorder an entire document,
  cross a table/form/parallel-text boundary, or use tail position alone.
- If pair constraints disagree, coverage is partial, or the candidates remain
  tied, abstain and preserve the baseline order.

### Experiment and gate

1. Reproduce the exact Text-Fidelity mechanism and its order diagnostics as a
   reference, including label- and reference-first-occurrence inversions.
2. Build a changed-page cohort from the 748 PDFs plus the ordered
   Text-Fidelity/PageXML surface; stratify columns, margin notes, short pages,
   tables/forms, bilingual/parallel text, endnotes, and cross-page notes.
3. Compare baseline and candidate on pairwise line-order accuracy, exact page
   text sequence, note pair precision/recall, label/reference inversions,
   paragraph/heading/list/table effects, and unchanged-page count.
4. Manually adjudicate every candidate-only reorder lacking independent order
   truth. Hold out whole source/template families.
5. Promote only with a real held-out order gain, zero loss on accepted
   high-confidence pages, no regression in any structure class, and negligible
   corpus runtime cost. Otherwise delete the experiment.

If promoted, it becomes one bounded witness in the ordinary PDF resolver and
the experimental switch is removed. It never becomes a general iterative
“structure repairs order repairs structure” loop.

## Definition of "universal"

The engine can be called universal for digital-born legal PDFs when:

- the same local evidence rules handle mixed legal structures without
  document-type branches;
- every emitted legal locator rehydrates to exact source lines/pages;
- pages, prose boundaries, headings, provisions, numbered paragraphs, lists,
  notes/endnotes, navigation, tables/forms, and furniture coexist without
  destructive relabelling;
- ambiguity abstains visibly;
- no supported structure class loses measured precision or recall;
- the complete corpus finishes within three minutes; and
- PDF, DOCX, backend, Authorities, and ALR consume one pinned citation/structure
  source with no duplicate grammar or format-neutral detector remaining.

The OCR/mixed lane earns the same claim only after Phase 3 also proves exact
anchor accounting, the non-journal ontology surface, and its separate hardware
throughput profiles. The paired-note reading-order addendum is not required for
either claim; it ships only if it independently improves order.

Implementation starts only after this interaction design and primitive
inventory are accepted.

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

## Historical ownership analysis

The repository-extraction proposal in this section is superseded. Its useful
boundary finding remains: format-specific extraction emits typed evidence,
while format-neutral detection and resolution must have one owner.

The current `legal-structure` crate is format-neutral but physically trapped
inside `legal-pdf-parser`. Phase 2 makes that ownership real by moving it to a
new public `legal-structure` subrepository. Reuse the established name; do not
invent a second engine or a differently named facade around it.

- `legal-pdf-extraction-processor` and `legal-pdf-ocr` own extracted geometry,
  text, spans, painted/raster separator observations, and source identity.
- `legal-pdf-structure` owns only PDF-dependent evidence: furniture, tables,
  columns, printed-page geometry, typography, note regions, flow proposals,
  and translation of those facts into shared witness summaries.
- `legal-pdf-pairing` retains the geometry-dependent note reference/body
  pairer. Its format-neutral label grammar, citation checks, and relation
  result types move to the shared repository.
- The new `legal-structure` subrepository owns citation grammar, text-only
  candidate detection, sequence/hierarchy selection, witness resolution,
  evidence validation, the structure graph, SourceDoc projection, and thin
  Node/Python bindings.
- `rust/src/structure.rs` remains orchestration only: PDF evidence in, shared
  graph out. It contains no citation, paragraph, section, heading, or note
  detector.
- Provider fetch, retrieval, storage, UI, document mutation, and URL resolution
  stay in their consumers. The structure repository never imports Beaver,
  AuthoritiesHelper, ALR, a provider client, SQLite, or an OCR/model runtime.

The existing `legal-structure-store` is deliberately not part of the new
subrepository. Complete the already-recorded installer check: if a real
provider installer consumes it, move that writer/reader behind the consumer's
persistence port; otherwise delete it. A structure-only repository does not
own a cache database.

### Dependency direction

```text
legal-citations (leaf; grammar + exact text spans)
        |
        v
legal-structure (evidence schema + detectors + graph + SourceDoc)
        |
        +--> legal-structure-node   --> Beaver/backend
        +--> legal-structure-python --> ALR / AuthoritiesHelper

legal-pdf-parser  --------> legal-citations + legal-structure
legal-browser-ocr --------> legal-structure evidence types
DOCX language code -------> legal-citations
```

No arrow points back toward PDF, OCR, a product, or a provider. The Python and
Node packages contain conversion and error mapping only. Rust callers use the
library directly; Node and Python callers cross an in-process boundary once
per document or batch, never once per line, citation, or footnote.

### Minimal subrepository shape

The new repository needs only:

- `legal-citations`: one leaf Rust crate and the sole authored legal grammar
  corpus;
- `legal-structure`: one Rust crate containing the format-neutral engine,
  split into ordinary source modules rather than the current giant `lib.rs`;
- `legal-structure-node`: the existing N-API binding, kept thin; and
- `legal-structure-python`: a thin PyO3 binding so ALR and Authorities use the
  same in-memory implementation without a subprocess adapter.

Do not add a service, plugin API, generalized rule language, separate schema
crate, repository-local store, or compatibility crate. Capability features on
`legal-structure` keep schema-only, recovery, SourceDoc, and provider-adapter
builds small without multiplying engines.

### Move, retain, and delete map

| Current owner | Target owner | Action |
| --- | --- | --- |
| `legal-pdf-parser/legal-structure` evidence schema, numeric selector, recovery grammars, graph, SourceDoc | new `legal-structure` crate | Move with history and exact behavior; split by responsibility only after the move differential is green. |
| `legal-pdf-support/pairing_support.rs` citation spans, cues, reporter inventory, normalization | `legal-citations` | Move and replace the boolean helper variants with projections of one scan result. |
| `pairing_support.rs` enumerator interpretation and heading ladder/text grammar | `legal-structure` | Move; PDF typography remains a PDF evidence input. |
| `legal-pdf-language/deterministic_citations.rs` splitting and field extraction | `legal-citations` | Move the deterministic syntax and exact-range behavior; DOCX package mutation stays in `legal-pdf-language`. |
| PDF and shared grammar-table copies, including McGill/US reporter data | `legal-citations/data` | Reconcile once, retain provenance/vectors, then delete every consumer copy. Bindings call Rust and do not ship independent JSON grammars. |
| `legal-pdf-parser/legal-structure-node` | new subrepository binding | Move unchanged first, then expose citation batches through the same native package. |
| `legal-pdf-parser/legal-structure-store` | provider installer/persistence owner or deletion | Do not move into the structure repository. |
| PDF geometry, column arbitration, separators, table/form recognition, furniture, printed labels, region classification | `legal-pdf-parser` | Retain. Emit typed observations/witnesses rather than final duplicate semantics. |
| PDF geometry-dependent note pairer | `legal-pdf-pairing` | Retain. Consume shared citation spans and emit shared note/reference/proposition relations. |
| backend `citationKey.ts` and local detection regexes | none after native cutover | Delete after exact key/span differential. |
| AuthoritiesHelper citation parsing/field regexes | none after Python cutover | Delete; TOA grouping, review, fields, and Word rendering remain product behavior. |
| ALR deterministic citation and format-neutral A2AJ/CourtListener structure copies | none after Python cutover | Use as the reference oracle during qualification, then delete the displaced code. |
| ALR provider lookup, rate governance, workbook workflow, URL policy, review UI, and product-specific quote decisions | ALR | Retain; these consume shared typed results and are not structure-engine behavior. |
| Text-Fidelity OCR/Codex repair | OCR/repair producer | Retain its algorithms; Phase 3 changes its evidence/output seam, not its ownership. |

If a private primitive needs reuse, expose a compact typed result from its
owner. Do not copy its logic into orchestration. During extraction, the old
implementation may execute only as a frozen differential oracle; no released
product contains both paths or a fallback flag.

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
| Codex/model output is treated as native or authoritative text | Typed operation validator and source-accounting gate reject unanchored or unapproved changes before structure analysis. |
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

## Retained PDF witness-resolver requirements

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

### 3. Add the small shared resolver and PDF witness adapter

- Assemble compact witness-family summaries from existing PDF primitives in
  `legal-pdf-structure`.
- Apply only direct exclusions and strongly proven non-note suppressions before
  pairing.
- Pair notes once with the canonical Rust pairer.
- Pass those typed summaries and pair relations to the current format-neutral
  `legal-structure` crate and resolve each marker level once using the
  principles and proofs above.
- Preserve one rule code and the authorizing typed observations for every
  changed heuristic result.

The target is a few hundred lines of orchestration. A generalized rule engine,
configuration language, plugin system, iterative optimizer, or second graph is
out of scope.

### 4. Materialize through the existing graph

- Preserve physical pages and prose paragraphs.
- Add real numbered-paragraph, section/provision, list, navigation, footnote,
  and endnote nodes only when proven.
- Preserve heading levels, page labels, source line IDs, footnote pairs,
  propositions, and containment/reference relations.
- Use the existing structure evidence graph rather than a PDF-only parallel
  result shape.

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

### Make the shared citation scanner the single citation utility

The existing grammar corpus, deterministic splitter, corrected Canadian/UK/US
reporter inventories, and ALR reference behavior are source material. This is
one parser with two useful entry points, not separate detection and splitting
engines:

```rust
scan(text, options) -> CitationDocument
split_units(ordered_units, context, options) -> Vec<CitationSplit>
```

`CitationDocument` contains exact Unicode-scalar ranges, surface text,
grammar/family ID, citation kind, normalized lookup key, pinpoint subranges,
protected ranges, and enough aggregate counts to calculate density without a
second scan. `split_units` invokes that same scanner and receives ordered prior
citation context explicitly, so supra/ibid chains cannot depend on hidden
global state or one-call-per-footnote choreography. `CitationSplit` contains
exact source ranges for authority parts, their fields and attached
quote/pinpoint/reference signals, plus an explicit `complete`, `partial`, or
`abstain` status. Concatenating its retained ranges and delimiters must account
for every input character.

The utility owns:

- citation and reference-chain span recognition;
- citation kind and grammar-family classification;
- deterministic overlap and boundary resolution;
- normalization and lookup-key generation;
- pinpoint and citation-bearing-unit boundaries;
- deterministic citation-part splitting and field extraction; and
- optional family filtering for a caller with known jurisdictional scope.

Filtering selects entries from the same parser and grammar data. `all` is the
ordinary default; `us`, `canadian`, or another family is not a forked parser.

The utility does not own provider lookup, authority identity confirmation,
network calls, URL selection, DOCX mutation, TOA grouping, workbook policy,
review UI, or rendering. A provider result may confirm or enrich a parsed
identity, but it may not create a citation boundary retroactively.

The PDF engine scans document text once and projects those ranges onto source
lines once. Footnote pairing, heading rejection, note/TOA evidence, citation
density, and citation lookup reuse the same `CitationDocument`; boolean helpers
become trivial queries over it. DOCX and ALR submit all note texts in a batch.
No normal product call crosses a language boundary per note or citation.

Core offsets are Unicode scalars. The Node binding converts once to explicitly
labelled UTF-16 offsets; Python uses Unicode-scalar/code-point offsets. Both
bindings have astral-character, combining-mark, CRLF, and normalization tests.
Normalization is comparison metadata only and never changes surface text or
source ranges.

### 2.4 Move every format-neutral structure detector

The shared `legal-structure` crate owns:

- `StructureEvidenceV1`, validation, coverage, origins, exclusions, and exact
  scalar-offset accounting;
- text-only marker/enumerator, heading-shape, paragraph/provision/list,
  note-label, reference, and restart candidates;
- the shared numeric sequence selector and hierarchy grammar;
- witness-family resolution that does not inspect PDF model types;
- graph nodes and containment, sibling, continuation, reference, pair,
  proposition, and reading-flow relation types;
- SourceDoc projection and exact lookup indexes; and
- the literal A2AJ, CourtListener/native-markup, and journal evidence adapters
  already proved by the SourceDoc cutover.

The journal contract remains literal: `pages.jsonl` contributes only its
exported facts, while plaintext is split only at standalone printed
`[page <label>]` markers and emits pages only. The shared engine must not infer
journal paragraphs or other structure from that plaintext adapter.

The principal document operation accepts the one precomputed citation scan:

```rust
analyze(evidence, citations, options) -> { structure_graph, diagnostics }
```

Citation-only consumers call `legal-citations` directly. A convenience
`analyze_document(evidence, options)` may scan once and call `analyze`. PDF uses
the explicit form: scan once, let the geometry pairer query those spans, add
its pair witnesses, then pass the same `CitationDocument` to `analyze`.
`analyze` rejects a citation text-hash mismatch. This prevents both a second
scan and the cycle in which structure changes the citation evidence that
created it. `compose_source_doc` remains a projection of that result, not a
second detector.

PDF-dependent code may propose column flow, typography, note bands, table
cells, printed labels, and geometry-backed pairs, then pass typed witnesses to
the shared resolver. It may not assign a competing semantic spine. Conversely,
the shared resolver never reads a bounding box to rediscover columns or note
bands.

### 2.5 Harvest ALR's reference behavior without importing the product

ALR Quote Verifier is the reference implementation for several primitives.
Classify each one before moving code:

| ALR behavior | Shared destination | What remains in ALR |
| --- | --- | --- |
| Deterministic citation splitting, field extraction, quote/pinpoint attachment, supra/ibid syntax | `legal-citations` | Product mode choice and presentation of unresolved parts. |
| A2AJ and CourtListener native/flat structure composition | `legal-structure` adapters and recovery | Provider credentials, fetch/cache, identity lock, rate policy, and URL choice. |
| Numbered paragraph/section detection and exact locator ranges | `legal-structure` | Selection of which provider document to inspect. |
| Reference-to-note and note-to-proposition boundaries | shared graph relations | Workbook columns, review policy, and prose shown to the user. |
| Format-neutral quote-span extraction, exact source matching, boundary refusal, and locator projection | shared deterministic evidence helpers in `legal-structure` | Deciding which authority is trusted, remote retrieval, status wording, and workbook workflow. |
| PDF extraction, geometry, note regions, and note pairing | canonical `legal-pdf-parser` | ALR's intake orchestration and error presentation. |

For each row, first determine whether the current Rust code is already an exact
port of ALR. If yes, preserve it and prove the differential. If ALR is better,
port only the missing behavior with its fixtures and provenance. If behavior
is product policy, leave it in ALR. Do not mechanically move the monolithic ALR
workflow into the neutral repository.

### 2.6 Bindings and release provenance

- Rust/PDF callers link the crates directly; this is the corpus-speed path.
- The Node binding accepts and returns ordinary batched objects in process. It
  contains no grammar, caching, retry, or provider code.
- The Python binding exposes the same batch operations through a platform
  wheel that PyInstaller can bundle. It contains no Python fallback parser.
- Each binding reports engine commit, grammar hash, schema version, enabled
  capabilities, and binding version. A consumer fails closed on an incompatible
  schema or missing capability.
- Beaver, PDF, AuthoritiesHelper, and ALR pin a released artifact from the same
  source commit. Local development may use the checked-out subrepository, but
  the release gate verifies embedded provenance against the declared pin.

This replaces manual ports with ordinary dependency updates. A citation or
structure improvement is authored and tested once in `legal-structure`, then
consumer contract suites exercise that same build. Generated bindings and
packaged binaries are artifacts, not maintained alternate implementations.

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
capability. The shared repository owns only the evidence types and structural
analysis. Beaver or another host invokes an authorized model through its
existing provider-neutral runtime operation; neither Rust core imports Codex
or a model SDK. Text-Fidelity remains the reference/oracle until this vertical
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

### 3.2 Use `StructureEvidenceV1` as the only ingress

Map existing outputs as follows:

| Existing repair fact | Shared evidence shape |
| --- | --- |
| page, region, line, word/span identity and geometry | `units` with stable IDs, source order, raw geometry, and origin |
| OCR/source text quality | page/line quality evidence and diagnostics; never an implicit authority promotion |
| region classification and membership | `region_layout` plus member line IDs |
| line order/flow proposal | line layout order/flow evidence; final reading order remains a relation |
| unnumbered prose boundary | `paragraph_breaks`; never a synthetic numbered paragraph |
| source-authored page/heading/section/note fact | `native_claims` with explicit coverage |
| model/detector heading, note, table, or list guess | proposal evidence with model/detector origin, never `native_claims` |
| accepted keep/retype/retag/reorder/split/merge/suppress result | validated replacement units/evidence with before/after hashes and producer provenance |
| unusable or contradictory area | explicit abstention/diagnostic; exact source anchors remain present |

Run a field-by-field fit test before changing the schema. The model-facing
repair request/response is a separate, typed PDF/OCR producer contract: it
references immutable anchors and returns proposed operations. A deterministic
validator either rejects those operations or materializes their effects into
ordinary anchored evidence. `legal-structure` never interprets free-form model
instructions. If an accepted relation or proposal still cannot be represented
without lying about authority, add the smallest typed field required and
version the contract. Do not encode the gap in an opaque metadata bag or
mislabel a Codex/model proposal as native.

The data flow is fixed:

```text
source page + immutable anchors
  -> OCR/extraction candidates
  -> deterministic layout/structure proposals
  -> bounded repair request/response for unresolved cases
  -> deterministic operation validation and materialization
  -> source-accounting and structure-evidence validation
  -> StructureEvidenceV1
  -> shared citation/structure analysis
  -> graph + SourceDoc/PDF projections
```

OCR and Codex never emit a competing final SourceDoc. A Codex response is not
evidence until the deterministic validator accepts and anchors it. The shared
engine remains the only place that reconciles native claims, accepted
proposals, exclusions, sequence, citations, and relations.

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
- Keep model selection outside the ontology. The current Codex route is a
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
   metered Codex repair experiment on source/template-held-out cases. Compare
   against the unchanged deterministic lane and preserve partial results.

Promotion requires complete anchor accounting, no unexplained text loss or
duplication, acyclic order, valid relations, coherent sequence state, stable
provenance hashes, and per-class non-regression. The three-minute target remains
the deterministic 748-document digital-born run; OCR/Codex has a separate
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

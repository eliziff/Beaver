# PDF structure gold and Rust structure redesign

Status: implementation candidate compiled on 2026-10-13. Shared span operations, authoring,
consumer integration and native inference/training paths are implemented; revised
gold, compatible trained models and candidate acceptance remain outstanding. The
performance and quality targets below are acceptance targets, not demonstrated results.

Project priorities and shared gates remain in the [master plan](master-plan.md).
The [shared structure plan](document-structure.md) owns primary profiles,
quotation ownership, non-PDF capabilities and integration requirements. The
[gold runner plan](../../experiments/legal-structure-gold/PLAN.md) describes the
current implementation; update its execution contract as this design is implemented.

On 2026-10-13 the maintainer authorized gold model authoring for up to 2,000
source records through the existing runner. The selected 1,209-source cohort is
within that cap; prior gold and receipts are retained. This authorization does
not lift the no-tests restriction or establish candidate acceptance.

The fixed cohort manifest and regeneration path are prepared. Automatic approval
review rejected the first launch pending explicit approval of the external
Codex/model destination and document transmission. No new model calls ran.

## Objective and scope

Build one source-anchored document contract in Rust. Independently authored gold,
the fast PDF parser and slower model-based producers use that contract. It must
express the source facts and structure needed by consumers without inheriting
the limitations of a particular extractor, detector or trained model.

This work covers PDF structure gold, its generator, PDF structure inference and
the shared Rust operations needed to apply and consume those annotations.
Within-PDF constituent boundaries, containment and resumptions are structural
facts and remain in scope.

Court-record classification, affidavit processing, record information extraction,
chronology and cross-document exhibit association remain a separate enterprise
with a separate runner. Do not merge their taxonomies, segment ownership,
workflows or acceptance criteria into this redesign. Preserve unrelated layers
already carried in a gold package. The form/authority catalogue also keeps its
existing owner; this work does not reclassify form kinds or legal authorities.

Existing components have no presumption of architectural value. Retain useful
capabilities and source evidence; replace obsolete production decision paths
outright. Do not turn this work into cleanup or consolidation of experiments.

## Evidence behind the decisions

The investigation examined selected gold packages, accepted authoring responses,
training and inference behavior, and rendered source pages. These are observations
of the inspected data and code, not results from running the proposed replacement.

| Finding | Consequence for the design |
| --- | --- |
| The selected structure gold contains 1,161 sources: 694 digitalborn and 467 OCR, covering 3,236 pages. Of these, 1,098 contain at most five annotated pages; the largest has 23. | Expand complete long-document coverage before claiming document-wide hierarchy quality. |
| Digitalborn gold contains 418 explicit noninitial `parent: null` units. The current digitalborn parent decoder always chooses a preceding unit after its first unit. | Represent root as an explicit inference candidate and a positive training target. |
| Training keys collapse 34 pairs of distinct structural starts sharing a source line, across 17 documents. Gold and scoring can distinguish their offsets. | Use span-level identities consistently in authoring, training, inference and evaluation. |
| OCR gold contains 148 marker-only insertions; 145 already have extracted body text. | Recover marker fragments in the source/OCR producer and associate them with the body. Parent inference cannot substitute for missing recognized content. |
| Accepted hierarchy edits contained ten non-null parent corrections that were not saved because assignment depended on whether the old block already had a parent attribute. | Assign explicitly supplied values unconditionally in the owning edit operation. |
| The hierarchy review admits existing headings, captions and marked blocks but omits ordinary unmarked prose. Inspected agenda divisions requiring promotion were therefore invisible to it. | Supply every block to the structural author and retire the separate filtered hierarchy repair pass. |
| Identical rendered pages have conflicting role annotations. Other inspected examples show inconsistent treatment of agenda divisions, form titles and incidental marginal text. | Set explicit classification rules and re-author affected structure under those rules. |
| Exact duplicate rendered pages occur in sources that the historical source-hash split assigns to opposite halves. | Split by related source/template families and duplicate-page groups, not source hash alone. This finding does not establish membership in a particular historical training run. |

Historical development improvements and timings are useful motivation, but do
not certify this design. Repeated tuning against a held-out cohort and missing
durable run manifests limit what those figures can establish. Measure a new
baseline and candidate against frozen independent answers.

Raw documents, private histories and authoring receipts remain in their existing
private stores. Keep durable evaluation material under the existing ignored
`benchmarks/local-data/legal-structure-gold/` owner and source PDFs in the canonical
OpenLegalData corpus. Do not copy private conversation content or identifying
document examples into public fixtures or this plan.

## Common contract and ownership

Use three parts of one document representation:

1. **Source content:** physical pages, identified text fragments and character
   spans, geometry, typography and extraction/OCR evidence. Physical reading order
   and logical continuations remain distinct.
2. **Structural annotations:** block membership, roles, locators, parents,
   document/scope ownership, tables, fields, notes, quotations and continuations.
3. **Derived views:** manuscript text, outlines, section extents, navigation and
   consumer exports.

The shared `legal-structure` owner supplies semantic types, literal annotation
application, assembly from supplied facts, validation and queries. PDF loading,
geometry, rendering, OCR and PDF-specific inference remain with `legal-pdf-parser`.
The gold runner owns model requests, authoring schedules and corpus publication.
Embedding applications retain provider/runtime selection and persistence policy.

Use the existing native interfaces rather than creating a forwarding service,
plugin framework or parallel graph. Non-PDF callers retain their authoritative
markup and native structure; they do not fabricate PDF geometry or undergo PDF
redetection. Preserve local and cloud support and primary structural profiles.

### Source spans and identity

- A structural unit may begin inside a physical line. Multiple units may share
  that line. Neither training nor inference may reduce their identity to a line ID.
- Preserve corrected text and the original extraction witness as different facts.
  Missing text insertions retain their source-page geometry and original evidence.
- Character edits use explicit Unicode scalar coordinates. Convert to UTF-16 at
  the consumer boundary where required; do not silently mix coordinate systems.
- IDs are local to an identified source representation. An alternative extractor
  need not reproduce the current extractor's line segmentation. Evaluation aligns
  candidate spans through page, geometry and text evidence.
- Keep exact printed text separate from manuscript normalization, including
  printed hyphens and logical word joins.

### Structure and derived extents

Every unit has document/scope ownership and an explicit outline parent, including
null for a root within that scope. Levels follow from parents and are not a second
authored truth. Numbering inside quotations cannot become the enclosing document's
primary spine. Repeated local locators in distinct constituents remain distinct.

Represent a headed section once, with its heading text identified separately
from its derived content extent. Replace artificial heading/section pairs whose
only purpose is to compensate for missing extent semantics. Preserve actual
numbered provisions and other substantive section concepts. Extents follow exact
membership and continuations; physical envelopes are not a substitute for them.

Gold can record explicit parents and discontinuous membership beyond the fast
producer's stack assumptions. The inference algorithm does not constrain what
independently authored answers can express.

Loading gold or generating an export must apply recorded facts literally. It
must not invoke classification or reparenting heuristics. Candidate outputs are
scored against canonical gold facts without generating a new expected graph.

## Classification policy

Captions, headings, instructions and headnotes are distinct, mutually exclusive
roles. The problem is inconsistent boundaries and misplaced granularity, not
overlap between those classes.

Use eight primary roles: `text`, `heading`, `caption`, `instruction`, `headnote`,
`marginal_note`, `furniture` and `page_label`.

| Current element | Target policy |
| --- | --- |
| `prose` | Rename to `text`, the default substantive-content role. |
| `heading` | Keep for headings organizing document contents. A document title belongs to its document annotation with exact source spans; it does not automatically establish an enclosing section. |
| `list_item` | Remove as a primary role. Preserve list membership, printed marker and nesting as structural attributes. Locator kind distinguishes list items, numbered paragraphs and provisions. Preserve unnumbered and bulleted lists too. |
| `caption` | Keep for legal captions identifying the proceeding and parties. Generic titles, confidentiality notices, stamps and figure labels do not receive this role. |
| `instruction` | Keep for directions about completing or using a form/template. Operative directions in a judgment or order remain substantive text. A placeholder remains a field rather than becoming an instruction. |
| `headnote` | Keep editorial summaries and catchwords accompanying a reported decision together. Do not split them into additional roles. A court-authored summary is substantive text, with any actual internal headings marked separately. |
| `marginal_note` | Keep substantive glosses associated with provisions or passages, with an association where identifiable. Stamps, archival identifiers and incidental marginal text become `text`. |
| `header`, `footer` | Merge into `furniture`. Geometry and physical OCR annotations retain position. |
| `page_label` | Keep printed pagination, including separate sequences in constituent documents. Other identifiers remain text unless another existing annotation describes them. |
| `unknown` | Remove as a completed semantic answer. Coverage records distinguish unannotated material from classified text. |

Apply the policy by function. A major agenda division is a heading; a leaf agenda
entry is text with list membership. A form identifier or document title is linked
to the document annotation rather than automatically labelled heading or caption.
Contents entries describe navigation and link to body targets; they do not become
body headings merely because their wording resembles a heading.

## Direction for every other structure-gold element

| Element | Direction |
| --- | --- |
| Paragraphs and blocks | Keep exact span membership, including boundaries within extracted lines. Preserve separate paragraphs and meaningful grouping. |
| Numbering and locators | Keep literal markers and paragraph/provision/list distinctions. Use shared grammars to expose ordinal values, compound prefixes, succession and restarts to inference. |
| Tables | Keep complete rectangular grids, blank cells, covered cells, merges and header rows. Preserve text and other annotations inside cells. An agenda or index may have table geometry without that geometry deciding the roles of its contents. |
| Fields | Keep text, signature, checkbox and choice types; label, value and placeholder distinctions; and checked/unchecked/unresolved state. Annotate printed form structure without inventing filled values or expanding into record information extraction. |
| Notes | Keep footnote, endnote, sidenote, table-note and author-note kinds, exact bodies, printed labels and reference spans. Position alone does not establish note kind. |
| Quotations | Keep exact extent, attribution, inline/display layout and independent numbering scope. Carry quotation identity into inference rather than only an inside-quotation flag. |
| Documents within a PDF | Keep source boundaries, containment, attachment/component relationships, printed title spans and resumptions. A heading, page break or numbering restart alone does not establish a constituent. Keep court-record classification and metadata extraction with their separate runner. |
| Word joins | Keep explicit source-preserving joins, including separators, distinct from paragraph or object continuation. |
| Object continuations | Keep paragraph, heading, note, table, quotation and list continuations. One logical object may contain several physical fragments across pages. |
| Document resumptions | Keep resumption of an existing document identity after intervening content; do not manufacture a new document for the continuation. |
| Contents and bookmarks | Keep source-anchored navigation entries and links to actual body targets. An unresolved target remains unresolved; it does not create a phantom body heading. |
| Physical OCR annotations | Keep corrected text, actual baselines, line/region polygons, membership and physical order. Retain the physical region taxonomy with its OCR consumer; legal roles have their own policy. Do not fabricate baselines from boxes or use incomplete annotation as negative training data. |
| Coverage | Keep complete/partial/unannotated coverage per task and source range. Completion of one authoring job does not establish completion of every layer. |
| Provenance and catalogue | Keep source/extraction identities, model/runner identities, accepted responses, usage and run receipts. Reuse the canonical corpus catalogue's selected gold; do not choose answers by filesystem timestamp. |
| Form/authority references and unrelated record layers | Preserve existing references and annotations. Their catalogue and separate runner remain their owners; this plan adds no authoring responsibility for them. |
| Exports | Derive manuscript, parser and OCR views from canonical gold. Exports are disposable views rather than a second authoritative annotation store. |

## Sparse correction interface

Keep sparse correction as the authoring interface. Source text is reused by ID;
the model emits changed characters, grouping decisions and annotation metadata.
It does not retype an entire transcription or serialize the entire document tree.

One shared typed applicator owns the following behavior:

| Operation family | Required behavior |
| --- | --- |
| Set role, parent or locator | Assign every explicitly supplied value unconditionally. Explicit null clears the value; omitted fields retain their existing value. A missing old attribute never prevents creation of the requested attribute. |
| Replace/regroup blocks | Construct complete replacement blocks from specified members and attributes. Remove superseded membership as part of the same operation. |
| Correct text | Apply bounded character edits while retaining the extraction witness. Preserve the existing ability to replace a badly recognized OCR line. Remap affected anchors when unambiguous and reject an edit that cannot preserve its declared references. |
| Split | Split at explicit character offsets and preserve source geometry and adjacency. |
| Insert | Recover genuinely missing printed content with an insertion anchor and source-image box. |
| Drop | Remove duplicated extraction with its duplicate relationship; do not drop meaningful source content merely to improve parser scores. |
| Move | Move identified spans relative to an anchor. Replace the model-facing requirement to emit a complete page permutation for a local order correction. |
| Join | Apply the specified logical join and separator without rewriting the physical source. |
| Continue/resume | Connect object fragments or resume an existing document identity. |
| Clear/remove | Clear a continuation or resumption, or remove an identified annotation, directly and completely. |

Recompute levels and derived extents from the resulting facts. Remove conditional
attribute assignment, duplicated Python/Rust mutation semantics and separate
hierarchy-sidecar mutation as active authoring paths. Use existing persistence
operations; do not introduce another journal or publication drift-detection stage.

Keep validation at the operation boundary for external values, source ownership,
span bounds and well-formed relationships. This is ordinary input validation,
not a second author attempting to reinterpret a successful edit.

## Gold authoring workflow

Use two authoring responsibilities, both automated:

1. **Source correction:** transcription, missing printed content, physical line
   and region data, grouping and reading order. Use page images and neighbouring
   context where needed.
2. **Document structure:** roles, structural boundaries, parents, ownership,
   tables, fields, notes, quotations, navigation and continuations over corrected
   source content.

The structural author receives every block, including ordinary unmarked text,
plus geometry, typography, navigation evidence and access to page images. Existing
parser proposals remain useful sparse-edit starting points; they do not filter
which source content the author may reconsider.

Supply short documents whole. Process longer documents in contiguous chunks,
with document-wide navigation context and carried enclosing scopes. Every block
appears in its owning chunk. Enclosing parent IDs must remain addressable across
chunk boundaries; context reduction must not turn them into inaccessible text
snippets or discard document/quotation identity.

Retire the separate hierarchy repair pass. Roles, structural boundaries and
parents have one structural author. Do not add mandatory reconciliation models,
human review queues or a cascade of independent repair stages.

Re-author the structural annotations of the existing 1,161 structure sources
under the settled policy, using their corrected source and sparse edits. Preserve
unrelated annotations, useful existing OCR data and original authoring evidence.
Source defects discovered during this work use the source-correction operation;
they do not trigger unrelated record enrichment or a wholesale OCR rerun.

Gold revisions must be justified by the source and annotation policy. A parser
score improvement is not a reason to change an expected answer. Freeze the
revised answers before model selection on the final evaluation split.

## Selected fast inference architecture

The default is lightweight learned disambiguation with one scoped hierarchy
assembler. Use boosted-tree predictors evaluated natively in Rust; training may
remain offline in the existing training environment. The fast production path
does not require a Python runtime or a heavyweight neural inference service.

1. Extract source evidence once, preserving geometry, typography, bookmarks and
   available PDF structure tags. Tags and navigation are evidence whose body
   targets must be established, not unconditional authority over visible content.
2. Build document-wide style and numbering evidence, normalized within document
   and constituent context.
3. Predict structural boundaries, roles and scope boundaries at source-span
   candidates. Preserve possible starts inside lines.
4. Assemble each scope using its active ancestor stack. An attachment predictor
   selects among the scope root and open ancestors. Root is an explicit positive
   training target. Open ancestors remain candidates regardless of distance.
5. Derive levels, section extents, manuscript relationships and navigation from
   the assembled facts. Do not run a later model that overwrites the hierarchy.

Use actual marker values and compound prefix/succession relationships, primary
profile, document-relative typography, source text, scope identity and confirmed
navigation matches. A quote Boolean, marker-family flag or inherited parser
parent is not an adequate substitute for these facts.

Maintain separate scopes for constituent documents, quotations and independent
reading streams. Preserve primary profile policy. Page breaks, typography and
numbering restarts are supporting evidence, not sufficient constituent boundaries.

Replace recent-40-unit parent selection and post-assembly learned reparenting.
Do not add a beam decoder: current evidence does not justify it. Candidate
restriction to open ancestors is an inference choice, not a restriction on the
gold contract. Keep source facts available when a producer cannot establish a
confident boundary.

### OCR marker recovery

Preserve and recognize isolated marker fragments, including those separated from
body lines by layout segmentation. Associate recovered fragments with the correct
body using source geometry, order and numbering context. Reuse the OCR producer's
recognition capability and source images; this does not require a new general
layout model. Feed recovered source evidence to structure inference rather than
training the hierarchy model to supply unseen printed markers.

## Slower model-based producer

The slower route is a separate producer of the same source-anchored annotations.
It consumes corrected/native source text, page images and document-wide context,
then emits bounded structural decisions through the shared correction interface.
It owns its resulting structure directly. Avoid ensembles of competing finished
trees followed by repair arbitration.

The producer may use fast proposals as an editing baseline, but receives all
source content and can replace their decisions. Provider/model selection stays
with the embedding application. Gold authoring and a runtime quality mode share
the representation and edit semantics, not a requirement to run one after the
other. Measure slow-route accuracy, tokens, calls and latency separately.

## Specific research and repository reuse

| Source | Adopt | Boundary |
| --- | --- | --- |
| [PageIndex Flash outline assembly](https://github.com/VectifyAI/PageIndex/tree/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/flash/outline_assembly) | Document-wide style grouping, heading-depth comparison and stack-based outline assembly. | Integrate these into the single assembler; preserve legal profiles, quote scope and constituent ownership. |
| [PageIndex classic](https://github.com/VectifyAI/PageIndex/blob/6d23caf416858f2ca136840305d1f479a86f6ef7/pageindex/page_index_classic.py) | Anchor contents entries to real body text; use neighbouring confirmed targets to bound searches. | Use local pagination relationships for compound PDFs instead of assuming one global page offset. Do not copy its repeated model verification/fix cascade. |
| [HELD](https://arxiv.org/html/2105.09297v1) | Sequential insertion into structurally available positions and explicit heading identification before hierarchy construction. | Its experimental results do not establish CPU latency or legal-document quality for this Rust implementation. The open-ancestor assumption belongs to scoped inference. |
| [Detect-Order-Construct](https://arxiv.org/abs/2401.11874) | Separate detection, reading-order and hierarchy evaluation so upstream failures are visible. | Do not import its model stack or benchmark labels as legal semantics. |

The [local PageIndex record](pageindex-detection.md) reports hierarchy F1 changes
from 0.143 to 0.201 for unnumbered heading work, and from 0.209 to 0.371 for heading
section extents on a different cohort. These are historical results on separate
runs, not additive gains or validation of this replacement. They support making
style hierarchy and section extent central concepts.

Reuse the existing vendored Inspector extraction and structure-tag capabilities.
Preserve its upstream identity, licence and required patches; do not create a
second fork or replace the PDF substrate merely as part of this semantic redesign.
The evidence reviewed identifies semantic and information-flow defects rather
than an established need for another PDF loader.

## Current implementation and remaining gates

The candidate uses exact source-span block identities, explicit parents and scope
ownership in the shared Rust representation. Literal source correction,
split/insert/drop, block and annotation replacement, local moves, joins,
continuations and resumptions use shared operations. Source witnesses survive
ambiguous OCR correction; accepted anchors require proven correspondence.
Native block preparation preserves starts within a line and cross-page objects.
Levels, discontinuous section extents and rendered membership derive from the
recorded facts. Bounded reads, quote lookup, tables and printed-locator consumers
receive those exact memberships. Native paragraphs, table rows/cells and paired
notes retain separate physical parts; grammar splitting clips those parts rather
than filling their gaps. List coverage derives through parent edges. Split units
rebind their physical line/page identities before style and scope inference.

Same-line style and tag features intersect aligned source spans, and independent
reading-stream histories can resume across quotation boundaries within one
document. Authority text retains producer-origin UTF-16 mappings through joins,
note-marker removal, dehyphenation and citation-boundary unit merging. Persisted
mappings identify the source document and text hash; generated separators remain
unmapped. Cache fingerprints include the normalization owner. Established PDF
outline projection uses the explicit roles, own source starts and derived nesting
instead of reconstructing hierarchy from the displayed text. Quotation lookup
now derives its source blocks inside the shared native operation from typed
reflection. The redundant public PDF paragraph-list API and TypeScript block
reconstruction are removed. PDF lookup and quotation preparation share numeric
locator normalization; repeated paragraph numbers remain unresolved and exact
memberships survive into matching. Quote specificity follows actual node ancestry;
repeated section labels abstain instead of selecting the last occurrence. Missing
subsections retain the limited unique-parent fallback. Duplicate paragraph text
remains searchable, and page/provision fallback remains available when no printed
paragraph number is unique. Query and quote text use the same exact-union and
whitespace-preserving materialization primitive. Non-PDF sources retain their existing locators.

Consumer projection now carries native node identities and recorded nesting levels.
Reference scopes follow actual parent edges and source-anchored graph endpoints;
typed locator/node seeds preserve resolved identities, while ambiguous unqualified
labels abstain. Bounded section/reference reads retain one exact node-identity
continuation, stop at the first omitted content range, and resume without skipping
or repeating ranges. Content coverage explicitly describes the selected section
or resolved reference content; completion does not claim reference resolution.
Native scopes report omitted edges with their original status and unmapped
endpoints when a known endpoint intersects the directional frontier. Read exposes
bounded omission details and total/status counts separately from content coverage;
unresolvable references do not create unactionable continuation cursors. Unknown
inbound targets cannot be attributed to a scope, so these diagnostics do not
claim exhaustive reference completeness. Table reflection uses producer-owned one-based table/grid
coordinates and ancestry, preserving blank and merged cells without decoding IDs.
Typed table header rows retain producer-owned one-based coordinates, including
explicit empty header sets. Range lookup uses recorded ancestry and exact member
unions; passage deduplication retains node identity, and typed locators resolve
ambiguity within their requested kind. Paragraph-range and provision-opening browser
links plan directly from those coordinates, preserving discontinuous membership
with multiple directives instead of searching reconstructed text or highlighting
envelopes. The existing browser replay planner checks complete word coverage and
source coordinates; incomplete plans retain the caller's existing fallback. Block
and table-cell text preserve touching rendered fragments and actual intervening
whitespace, including authored dehyphenation seams. All five note kinds retain
exact label/body memberships through typed gold and
composition round trips; sidenotes, table notes and author notes need no synthetic
footnote node. Typed field annotations retain kind, unresolved/checked/unchecked
state, ownership and exact source/label/value/placeholder spans across gold export
and composition import, without manufacturing outline nodes. Atomic passage capture selects exact owned parts, including
same-line and discontinuous units, rather than treating their envelopes as text.
These are implementation changes; independent accuracy and performance acceptance
remain unmet.

Source continuation and word-join facts retain explicit endpoints and literal
separators through the typed document and authoring seed. Native paragraph/note
links are attached only where source/output witnesses establish every cross-page
seam; existing joins remain authoritative. Document scopes distinguish direct
ownership from inclusive containment. Composition uses actual document annotation
identities, including coincident openings and remote parent/resumption references.
All continuation kinds enforce compatible enclosing ownership; list endpoints
retain list identity and note fragments must agree on kind. Continued quotation
fragments exclude their canonical logical self when resolving enclosing scope,
and nested quotation parent identities survive export.
Both sparse response formats use existing annotation aliases for updates and
explicit response-local document declarations for new identities; declarations
resolve before parent/resumption references, including coincident openings.

Native logical blocks now seed page-addressable fragments with inherited
continuity. Unknown text separators remain explicit pending obligations until
the target chunk is authored; supplied continuation commands and final assembly
require a literal separator or an explicit rejection of that link. Partial
assembly is explicitly incomplete. Printed text and scalar manuscript edits
survive typed structures, composition, source correction and gold projection.
Native paragraph witnesses can establish an exact removed terminal hyphen and
its empty join without deleting printed source; unproved omissions such as
repeated labels remain unresolved. This does not establish complete manuscript
fidelity.

Complete composition now projects into `DocumentStructure` through the shared
Rust `projectStructureComposition` operation. It applies the literal request,
constructs source/rendered memberships and all annotation layers, remaps retained
native facts only through source correspondence, and uses the existing assembler.
Unknown producer evidence is retained separately with typed values authoritative;
unproved native anchors remain explicit unconfirmed witnesses. Gold export only
packages that result. The provider-neutral model composer uses the same projection
for complete requests; partial chunks retain unfinished composition state. This
removes the gold runner as the owner of composition-to-document semantics. Native
preparation now supplies notes, fields, table grids, document/quotation scopes and
navigation together with its editable blocks. It identifies exactly which native
nodes those facts represent, preserving unresolved native grids and other
unrepresented evidence. Source-view continuation resolution is shared by
authoring context and final projection, including links from the physical tail of
an already multipage annotation. Partial source views do not require final
manuscript separators. Python no longer merges annotation fragments or computes
quotation containment. The model-facing note contract now requires explicit
printed-label spans and exact referring-marker spans for all five note kinds;
it no longer describes whole body lines as references or silently supplies an
empty label when one is omitted. Explicit field replacements likewise supply
label/value/placeholder spans and state; tables supply complete grid, header rows
and merges. Sparse omission retains a correct annotation. Confirmed navigation
can target exact body membership or a declared document title without creating
a heading; printed contents entries and container envelopes are not destinations.
Native bookmark confirmation still requires its original destination witness.

Complete logical text continuations now require matching primary roles and
explicit parents, compared through actual continued-parent identities. Retained
native children rebind to a unique regenerated logical parent through recorded
source membership. Ambiguous or incompatible relationships retain original
parent evidence rather than silently choosing a fragment. Typed cell/row/table
containment can cross content scopes; semantic outline parents still reject known
scope conflicts. Missing legacy ownership remains unknown.

Independent reading-stream scope membership now supplies exact block cuts and
ownership even when role nodes do not carry it. Training consumes the same
explicit membership, marking partial targets unavailable and rejecting conflicting
declarations.
Mixed stream/unpartitioned annotations do not widen stream ownership, and native
cross-page continuations cannot join distinct streams. Zero-width or unaddressable
stream declarations retain their original evidence and an explicit unsupported
reason through direct projection and native factual persistence. These are source
reviewed implementation paths, not demonstrated behavioral results.

Partial compositions now carry surviving native-node inventory through the shared
applicator. Explicit removal follows native parent IDs to remove descendants;
reopening a chunk no longer reseeds removed facts. Current removal spans follow
physical splits and transcription through shared source operations. A correction
that makes a native span ambiguous leaves the fact unanchored with its original
evidence intact. Physical pages remain source-owned.

Original producer extras remain coordinate-tagged native witnesses, isolated from
current source aliases, correction anchors and rendered projection. Typed native
cross-reference and contents coordinates are remapped explicitly; unconfirmed
edges retain their original evidence outside the active graph, whose counts are
recomputed from retained edges. This prevents old named offset fields from
silently surviving source correction. No model dispatch or behavioral acceptance
has established these paths.

Authority passage geometry now carries exact source membership through paragraph
and printed-statute lookup. Statute reading transformations retain their mapping
back to print; native geometry intersects real word witnesses and emits separate
source fragments rather than whole lines. Missing geometry remains unavailable.
Authority consumers preserve those rectangles, including separate margin marks,
and no longer replace an ambiguous paragraph lookup with a bracket-number scan.

Gold authoring has source and complete-block structure responsibilities, the eight
roles, addressable enclosing context and a structural reauthoring entrypoint.
Initial authoring and reauthoring both lock corrected source and require explicit
complete TARGET block decisions. Their shared pre-mutation guard rejects physical
source edits; structural prompts report source defects, which prevent
publication until the source-correction responsibility handles them. Clear-link
opcodes retain their literal meaning through the Python adapter. Complete block
answers carry explicit source-anchored reading-stream identities, including
streams that resume across quotations. Existing stream identities normalize
before the first request. Carried continuation context includes exact inherited
endpoints and the latest earlier objects in active/enclosing scopes, allowing
source-supported resumptions beyond the adjacent image window.
Authoring checks PDF page-appearance capability before preparation, cached-run
acceptance, structural publication (including interrupted replay), new structural
package selection and freeze validation. PDFs requiring dynamic XFA rendering
cannot be treated as complete merely because their fallback page renders without
warnings. Explicit static XFA remains supported; missing or ambiguous rendering
declarations require source review. This metadata check identifies unsupported
rendering requirements, not proof that every source page is complete. Freeze uses
the source resolved and hash-verified within its requested corpus directory.
The separate filtered hierarchy author is retired. The model-assisted composition
operation uses the same sparse contract; provider dispatch remains caller-owned.

Fast inference supervises exact fragment starts and ends, including an explicit
unowned-gap boundary, then selects scope identity before logical membership.
All learned stages receive complete physical-source witnesses with prepared
navigation, quotation, table and layout context. Training consumes the same
source-derived navigation evidence rather than gold-confirmed navigation targets.
An independent native count regressor now opens constituent and quotation
identities at exact physical-source candidate anchors before direct ownership is
selected. Scope openings now share word, typography, numbering and quotation
boundaries with the span predictor rather than depending on selected role-node
starts. Training and inference score the same physical intervals; gold-only role
boundaries cannot manufacture candidates, and missing ownership does not become
false root supervision. Selected ownership changes split materialized units.
Shared exact-membership rendering preserves real whitespace in continued heading
labels and learned membership features. Exact span typography now carries its own
document-wide style rank, source-line frequency and body-style membership.
Physical candidates carry shared-grammar ordinals, compound prefixes and
whole-source sequence neighbours; the scope ranker compares them with each
identity's last numbered marker through intervening text. Succession and restarts
remain evidence, and never declare document or quotation ownership. These input changes require span-role v7,
scope-identity v8, scope-opening v3, fragment-membership v4 and parent v6 models;
no compatible replacement models have been trained.
Coincident declarations remain distinct, and an enclosing scope need not directly
own a source unit. The scope ranker selects their parents and separately selects
a quotation's owning document; explicit null roots differ from the named
transport-document root. Opening slot and selected ancestry distinguish
coincident identities. No fixed nesting vocabulary is imposed.
Typed scope annotations supply opening counts and relationship targets, not
input features. Unaligned or unanchorable openings remain explicit unavailable
targets. Missing annotation anchors stay unknown and exclude affected count
labels rather than producing false negatives at earlier source positions.
Declared scopes retain source opening membership and accumulate inclusive
descendant ranges separately from direct owned ranges. Titles, relationships and
quotation attribution/layout are retained by the shared contract but are not
newly predicted by these heads. Compatible opening and identity models are
required together; no compatible pair preserves the existing heuristic path,
while a partially configured compatible pair is an explicit error.
A native membership ranker chooses a new unit or an eligible earlier same-role,
same-ownership unit, merging exact ranges into the first-anchor node before
root/open-ancestor outline assembly. Mixed-owner table containers abstain from
overwriting their cells. Native training reports unavailable gold endpoints
rather than inventing source candidates. The outline, span, scope and membership model
contracts changed, and a scope-opening contract was added; compatible trained
weights remain absent. Membership ranking
currently compares all eligible prior units, so its quadratic worst-case cost
remains an unmeasured performance gate. Post-assembly learned reparenting and
the recent-unit window are removed. Offline training consumes the native feature
operations and a frozen family manifest. Missing compatible model weights leave
the corresponding learned stages inactive; wiring these stages does not establish
learned accuracy. Existing legal profiles and non-PDF authoritative structure remain
separate from PDF evidence preparation.

The prepared manifest now selects the canonical 1,161 structure packages
(3,236 pages), rather than the 1,047 legacy exports. Structural reauthoring
requires 1,254 five-page chunks before retries. All selected supporting artifacts
and source PDFs exist. The last capability-aware preparation produced 1,250
prompts for 1,157 supported sources, with no errors, model calls or gold changes.
That preparation predates the shared document projector and corrected document
module instructions; it is historical evidence, not validation of their current
behavior. No authoring preparation or model run was repeated for this batch.
Four dynamic XFA sources remain selected but blocked: their ordinary page trees
contain viewer-fallback notices instead of the actual forms. Three static XFA
sources were independently inspected and remain supported. Private source-review,
preparation and readiness receipts retain evidence and final code hashes.
Earlier preparation of all 1,254 prompts remains historical evidence, not current
readiness. The full cohort's bounded 3,762-call maximum remains a planning ceiling;
1,250 previously prepared chunks imply at most 3,750 calls for that schedule. Dispatch awaits explicit
model/transmission authorization.

The private corpus selection contains 48 distinct complete sources over 30 pages,
12 in each requested group, with scans represented across groups. It covers
7,544 pages and uses existing corpus sources. Family and duplicate-text-page
membership is recorded beside the existing private gold owner. This is a selection,
not 48 newly authored gold documents or a completed evaluation freeze. Local
visual fingerprint preparation now covers all 1,209 sources and 10,780 pages.
The compact candidate index retains 10,709 rasters in 10,440 signature groups,
including 92 groups with cross-source occurrences, all 8,364 cross-source
neighbouring-signature relationships within three bits, and 19 exact
low-resolution raster groups. Candidate-rule coverage is complete without
truncation; duplicate-page/family review remains outstanding. Diagnostics
are retained for 116 sources. Targeted visual review covers five exact-raster
groups crossing families and equal-signature through three-bit relationships
touching their recorded provisional-test selections. The two-bit stage reviewed
107 relationships across 193 unique candidate pages; the three-bit stage reviewed
282 relationships across 316 pages. Supported evidence includes specific templates,
related proceedings, source versions, duplicated pages and overlapping embedded
decision material within compilations. Generic layouts and viewer-fallback notices
do not establish family links. Receipts distinguish candidate fingerprints from
inspected render identities and retain uncertainty about unreadable underlying
content. Every partition refresh requires a remaining-candidate audit because
new families can change provisional-test membership. The latest audit covers all
386 current test-touching cross-family signature relationships through three bits;
all 316 members of known-exposed families remain in development. Broader source-family
relationships and historical exposure remain incompletely reviewed. The 48 long sources
require 7,544 source-correction chunks and 1,530 structural chunks; 27
have OCR mode and 21 now have evidence-based digitalborn mode proposals from
existing harvest records/read-only source characterization. One source emitted
PDF syntax diagnostics, retained explicitly for review. The private
`long-authoring-inputs.json` binds these inputs to the unchanged 48-source selection.

The final-freeze operation retains a prepared cohort, verifies complete canonical
source/structure authoring and reviewed family/page/exposure membership, then
binds source, artifact, text, authoring, selection and review identities. It has
not been executed. Training verifies this binding and reads only training
artifacts. Freeze preparation and training share family validation: canonical
family identities, full evidence closure through unselected sources, selected
source membership and partition consistency. Recorded exposed identities force
their entire connected family into development. The historical audit identified
158 directly exposed selected sources, affecting 315 selected sources through
135 families; later source-family evidence expanded the affected membership to
316. Incomplete histories remain unresolved. The initial exposure refresh moved
287 sources to development, including 16 from the former test partition; later
family refreshes are recorded in the private selection receipts without changing
the cohort or long-source group assignments. Initial authoring and
structural reauthoring share a current-policy proof; neither requires an extra
structural pass solely for freezing.

Canonical native persistence is now implemented through a shared source-anchored
payload in `legal_structure.native`. The Rust owner captures retained nodes,
physical pages and typed metadata, then remaps their scalar bindings for source
splits, drops and transcription. Hydration restores current coordinates for
packing, reopening and structural reauthoring. Explicit removals prune retained
facts; uncertain coordinates and unknown producer leaves remain immutable,
identified witnesses. Cross-reference citations require unchanged wording;
node and target extents use the shared transcription boundary rules. Physical
blank pages, zero-width facts, tagged-PDF structure, outline witnesses and parents
that refer to regenerated authored nodes retain their distinct handling.
No canonical gold files were rewritten and no behavioral round-trip was run.

Remaining work is explicit:

- Obtain complete source-backed page appearances for the four dynamic XFA
  sources. Their current PDF page trees contain viewer-fallback notices; retain
  the sources and historical gold, but do not accept those notices as complete
  form content. Three separately inspected static XFA forms remain supported.
  The installed PDFium builds lack XFA support; installed PDF.js can lay out XFA
  but does not execute the ready scripts that populate visible page fields in
  three of these sources. The private `source-xfa-renderer-capability-review.json`
  records this remaining capability gap without claiming rendered completeness.
- Re-author the selected existing structure sources under the settled policy and
  author all 48 long documents. Current selected gold contains no complete source
  over 30 pages. No new authoring model calls have been made for this candidate.
- Finish visual duplicate-page/family and historical exposure review, then freeze
  the revised gold and training/development/final-evaluation membership together.
- Train compatible span-role, scope-opening, scope-identity, fragment-membership and parent models from that freeze. No training
  run has been performed for this candidate.
- Update the existing evaluator's line-keyed group/parent extraction for exact
  span identities and all structural roots before using it for acceptance. Its
  old aggregation must not be reported as proof of the new contract.
- Establish omitted-ink recovery quality when behavioral runs are authorized.
  The maintained runtime wheel is built in its canonical location. The supplied-geometry
  recognition operation and Rust caller now exist under the PDF OCR owner. They
  use the original full-page image and existing uncovered-ink candidates, with
  recovered geometry marked explicitly. The detector remains horizontal and
  requires at least three segmented lines; this is not arbitrary missing-content
  recovery. No OCR execution has established recall or false-positive rates.
- Run the independent source/structure/consumer and performance gates below.
  The current instruction forbids writing or running tests; no tests, evaluation,
  benchmark or acceptance run was added or executed during this implementation
  phase. Compilation and source inspection do not establish behavioral quality.

Metered model calls and transmission of private documents retain the master
plan's explicit-authorization requirement. Prior gold and historical measurements
remain independent; they are not candidate results.

The consolidated native build (`node scripts/native-build.mjs`) passed on
2026-10-13 in 33.27 seconds using the canonical incremental target. This includes
literal continuation-parent/role consistency, retained-parent identity rebinding,
exact body/title navigation and scoped table-grid containment, together with all
preceding implementation batches. Compilation establishes type/link consistency,
not behavioral quality.
Detailed batch findings and earlier compilation results remain in the private
implementation audit.

The canonical shared contract runtime was regenerated for the consumer batch.
The maintained OCR runtime wheel built offline into
`legal-pdf-parser/runtime/kraken/runtime.whl`; no model or OCR execution was made.
Python AST and JavaScript syntax checks passed. The backend production type-check
was rerun for the reader changes and reported only the same four `S3Client.send`
errors in unchanged `backend/src/lib/storage.ts`. Final context-coverage labeling
and removal of a duplicate continuation appendix were peer-reviewed and syntax-parsed
after that check. The previous frontend check reported
twelve implicit-type errors in unchanged `frontend/vite.config.ts`; no frontend
files changed in this batch. Neither TypeScript check passed.

No tests were written, run or compiled. Existing test imports and constructors
for removed production APIs remain untouched under that instruction. The unrun
behavior and performance gates still prevent candidate acceptance.

## Completion audit — 2026-10-13

Three independent source reviews covered the shared annotation contract, native
inference/training inputs, and authoring/consumer paths. They found no additional
definite implementation defect in those reviewed requirements. This is source
evidence, not behavioral acceptance or a completed plan.

| Step | Current status |
| --- | --- |
| 1. Shared contract | Implementation candidate; behavioral proof unrun. |
| 2. Annotation and authoring | Authoring implementation present; revised gold absent. |
| 3. Corpus and freeze | 1,209 sources in 946 families selected, including 48 long documents; full review, authoring and freeze incomplete. |
| 4. Native inference | Implementation present; compatible five-model weights and empirical proof absent. |
| 5. Acceptance | Exact-span evaluator update and behavior/performance gates remain outstanding under the no-tests instruction. |

The long cohort has 12 documents in each required group, 7,544 pages in total,
and at least 31 pages per document. Its saved inputs remain preparation only.
Broad family and visual-review completeness flags remain unset for all selected
sources; the bounded candidate reviews above do not establish full review.
No final freeze exists. The private implementation audit records source hashes,
review coverage and outstanding gates. No build or behavior run was repeated
for this documentation-only completion assessment.

## Implementation sequence and completion criteria

### 1. Establish the shared contract and literal operations

- Implement span identities, explicit scope roots, document/quotation ownership
  and derived levels/extents in the existing Rust owner.
- Route gold edits and model-produced annotations through one literal applicator.
- Fix all direct consumers of changed identities and semantic fields together.
  Preserve non-PDF authoritative structure and primary-profile behavior.
- Remove superseded production mutation/assembly paths in the same cut. Do not
  add compatibility or migration infrastructure, or delete experiments.

Completion: distinct same-line units survive application and export; a new parent
can be assigned to an initially parentless block; explicit null establishes a
root; quote and constituent locators stay isolated; exact source text and logical
continuations remain available to consumers.

### 2. Apply the annotation policy and new authoring schedule

- Update role definitions, locator/list attributes and document-title anchoring.
- Give the structural author complete block coverage and enclosing scope context.
- Retire the filtered hierarchy repair pass and redundant authored levels.
- Re-author structural annotations over the existing corrected sources using
  sparse corrections. Preserve unrelated layers and the separate record runner.

Completion: eight-role gold expresses all retained structural distinctions;
unmarked text can be promoted; tables, fields, notes, quotations and continuations
retain their source-grounded answers; coverage accurately describes each layer.

### 3. Freeze family-based evaluation and expand long documents

- Group identical pages, source versions and related templates before assigning
  training, development and untouched test sets. Save the membership manifest.
- Add 48 complete PDFs over 30 pages: 12 judgments, 12 legislative documents,
  12 compound PDFs and 12 bilingual or multicolumn publications. Use four primary
  selection groups so a document is counted once; include scans across the groups.
- Find suitable sources in the existing corpus before acquiring new ones. Retain
  full-document context and expected constituent/quotation boundaries.
- Measure the current parser against frozen revised gold before training the
  replacement. Keep model selection on development data.

Completion: source-family overlap does not cross the evaluation boundary;
long-document and difficult-layout behavior has explicit expected answers; the
baseline and candidate use the same gold identities and evaluation manifest.

### 4. Replace competing hierarchy stages

- Reuse numbering grammars, useful style evidence and confirmed navigation
  anchors as inputs to the chosen predictors and scoped assembler.
- Train with span identities, explicit roots, actual ordinal relationships and
  document/quotation scope. Eliminate line-key collisions and all-negative root
  queries caused by an absent root candidate.
- Route production through one assembler and remove subsequent learned
  reparenting and the recent-unit candidate window.
- Connect OCR marker recovery upstream of structure inference.

Completion: every gold distinction needed for this training is representable;
open ancestors remain available over long distances; scopes cannot acquire one
another's locators; no later stage silently replaces the assembled hierarchy.

### 5. Validate consumer outcomes and candidate performance

Measure source recovery, unit boundaries, role confusion, document ownership,
parent links, continuations, tables, notes, fields and quotations separately.
Also measure manuscript fidelity, source lookup, outline navigation and bounded
reads through affected consumers. Report per-mode and per-profile results rather
than allowing frequent text blocks to hide rare-role failures.

Evaluate both complete extraction-to-structure behavior and structure behavior on
fixed corrected source. This separates missing-input errors from inference errors.
Keep cold/warm timings, end-to-end p95 latency and peak memory alongside model-only
costs. Use the same hardware, inputs and measurement conditions for comparison.

Proposed acceptance targets:

- At least a 20% relative reduction in `1 - F1` for unit detection and end-to-end
  parent-link F1, separately for digitalborn and OCR sources. Missing or spurious
  units must count in parent-link evaluation; do not score only matched units.
- No material regression in tables, notes or quotations, and preservation of
  required profile, source-fidelity and consumer contracts.
- No more than a 5% increase in end-to-end p95 latency on the fixed measurement
  cohort. Report memory alongside latency and preserve existing memory gates.

These targets do not replace the distinct corpus/integration gates in the shared
structure plan. Do not adjust gold or remove hard examples to meet them. A failure
is a failed candidate, not an invitation to reopen the architecture implicitly.

## Owning files and validation discipline

| Responsibility | Existing owner to update |
| --- | --- |
| Semantic types, annotation application, profiles and queries | `legal-structure/` and its existing bindings |
| PDF evidence preparation and production assembly | `legal-pdf-parser/legal-pdf-structure/src/structure.rs` and connected PDF owners |
| Lightweight model features and outline inference | `legal-pdf-parser/legal-pdf-witnesses/src/`, especially `model.rs`, `outline.rs` and `witness.rs` |
| Gold authoring, prompts, source correction and packaging | `experiments/legal-structure-gold/`; the current shared correction schema is in `legal-pdf-parser/experiments/structure-composer/composer.py` |
| Hierarchy pass to retire as a separate author | `experiments/legal-structure-gold/hierarchy_pass.py` |
| Direct fact scoring and batch evaluation | Existing `evaluate.py` and `score_all.py` under the gold runner |
| Shared-structure consumer integration | Existing native bindings and consuming bounded-query operations; do not recreate semantic logic in TypeScript |

Trace concrete callers before editing each owner. The table assigns
responsibility; it does not preserve accidental existing module boundaries.
Moving semantics into the proper owner is part of the refactor, while historical
experiments and private evidence remain intact.

Follow [CONTRIBUTING.md](../../CONTRIBUTING.md) and each owning repository's agent
instructions. Iterate with affected-crate checks and focused behavioral proof;
the PDF owner currently uses `cargo quick` during ordinary iteration. Use one
Cargo job/build at a time, ordinary incremental targets and a single final linked
candidate for the required behavior gates. Do not rebuild the full workspace,
addon or release binary after each feature adjustment.

Use independently invented unit fixtures or documented public-source fixtures.
Run the independent gold and integration gates for native semantic changes.
Keep real/private corpus inputs and irreplaceable receipts in their durable
owners, and bound disposable outputs to one reusable location. No full sweep is
authorized by this documentation work.

## Explicit removals and retained boundaries

Remove conditional correction assignment, duplicate mutation semantics,
independently authored hierarchy repair, redundant authored levels, line-only
training identity, recent-40-unit parent selection, post-assembly reparenting and
artificial heading/section pairs that only compensate for missing extents.

Do not add a beam decoder, detector registry, general graph framework, new gold
store, mandatory repair-model cascade or publication drift checker. Keep sparse
corrections, source fidelity, primary profiles, exact annotations, useful OCR
evidence and bounded consumer queries. Court-record and affidavit workflows keep
their separate runner throughout.

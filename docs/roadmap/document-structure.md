# Shared document structure

Status: active implementation plan

This is the only active plan for the structure refactor. Earlier plans remain
in Git at root commit `54f89938` and `legal-pdf-parser` commit `2b2c341e`.
The detailed detector inventory, parity evidence, witness analysis,
OCR/digital-born and Luna work, citation work, ALR quote-verifier port, and
Phase 4 remain in
[document-structure evidence](../decisions/document-structure-evidence.md),
[source-structure cutover results](../decisions/source-structure-cutover-results.md),
and the parser's
[evidence inventory](../../legal-pdf-parser/experiments/structure-engine-parity/EVIDENCE.md).

## Goal

Finish `legal-structure` as one compact Rust utility that:

- accepts a document and any authoritative source-native facts;
- runs every applicable mature structure detector without weakening it;
- returns one canonical `DocumentStructure`;
- can project that result into `SourceDoc` in the same call; and
- can be called directly from Rust/Python and once per immutable document
  version from Beaver.

The refactor replaces the old design outright. There are no compatibility
layers, migrations, feature flags, dual writes, production fallbacks,
intermediate JSON protocols, or second analysis service.

Minimal does not mean shallow. Each vertical cut must port the full behavior,
rewire every affected consumer, prove exact fidelity, and delete the displaced
implementation. We share only operations shown to be semantically identical;
PDF, provider, instrument, DOCX, journal, citation, and OCR rules remain
distinct where their evidence or refusal semantics differ.

## Final architecture

```text
typed source adapter or complete ExtractedPdf
  -> source-native facts + applicable mature detector lane
  -> final nodes and named typed products
  -> assemble_document_structure
  -> DocumentStructure
       -> optional SourceDoc projection
       -> Beaver/Python/Rust queries
```

### Public calls

Node exposes one generated typed N-API operation:

```text
deriveDocumentStructure(source, { sourceDoc: true | false })
  -> { structure: DocumentStructure, sourceDoc? }
```

`StructureSource` is only the tagged dispatch input needed to replace the
current untyped command router. Its variants reuse the existing A2AJ,
native-markup, journal, and instrument inputs; DOCX/grid variants are added
only when their typed inputs land. It is not a generic format-evidence bag.
The PDF parser links `legal-structure` directly and makes one in-process call:

```text
derivePdfDocument(complete ExtractedPdf, identity, { sourceDoc })
  -> { structure, pdfSourceMap, sourceDoc? }
```

The parser composes that result with the already-owned PDF artifacts and
operation receipt. PDF geometry never crosses Node. A thin Python binding
calls the corresponding Rust source operation directly.

`SourceDoc` is an explicitly requested consumer projection. It may repeat text
and blocks at that output boundary, but it never becomes a second detector or
internal source of truth, and its projector borrows the structure's semantic
text rather than rebuilding it. The source adapter supplies the existing
`provider`, `url`, and `doc_type` egress metadata to
`project_source_doc(&structure, provider, url, doc_type)`; those fields do not
belong in canonical structure.

### Ownership

| Owner | Owns | Does not own |
| --- | --- | --- |
| Source adapter/capability | Source-specific parsing, native claims, mature detection, ambiguity/refusal policy, private candidates/witnesses | Generic assembly, Beaver persistence, consumer summaries |
| `DocumentStructure` | Semantic text and identity, source authority, selected nodes, paired notes, typed capability results, semantic diagnostics | PDF geometry, DOCX XML/session state, grids, copied artifact payloads, SourceDoc indexes |
| Format artifact | PDF pages/lines/tables/images/OCR/layout and source map; `DocxSession`; spreadsheet grid | A parallel semantic graph/skeleton/note model |
| SourceDoc | UTF-16 consumer blocks, revision/status/index/ranges | Detection or canonical scalar coordinates |
| Beaver | Acquisition, one read/call, persistence, mutation, lint presentation, navigation/query policy | Structure detection, reparsing, sidecars, provider-specific redetection |

Provider adapters preserve provider-given structure. They translate native
facts and state whether coverage is partial or complete; flattening the text
and redetecting what the provider already supplied is forbidden. Their
remaining source-specific code should be translation, not a parallel detector.

### Canonical contract

`StructureGraphV2` evolves directly into `DocumentStructure`; there is no
wrapper and no compatibility alias.

```rust
pub struct DocumentStructure {
    pub schema_version: String,
    pub document_id: String,
    pub text: String,
    pub text_sha256: String,
    pub source_sha256: Option<String>,
    pub scope: Scope,
    pub origins: Vec<Origin>,
    pub nodes: Vec<StructureNode>,
    pub notes: Vec<Note>,
    pub contents: Option<InstrumentContentsReading>,
    pub definitions: Option<DefinitionsResult>,
    pub provision_references: Option<ProvisionReferencesResult>,
    pub attachment_references: Option<AttachmentReferencesResult>,
    pub numbering: Option<NumberingResult>,
    pub diagnostics: Vec<StructureDiagnostic>,
}
```

This is the final target, accumulated by the owning cuts. Cut 1 lands only the
identity/text/scope/origin/node/diagnostic fields already backed by live
producers. Each later cut adds its named product when the literal detector
lands; no empty fields, dispatch variants, or placeholder modules are added in
advance. Engine/parser/grammar versions belong to the existing operation and
cache receipt, not the semantic result.

`None` on a named capability means it did not run for that source. An empty
successful result means it ran and found nothing. A refusal carries its exact
typed reason and the metrics that authorized it. There is no generic
`capabilities`, `attributes`, `observations`, `Value`, or confidence bag.

There is also no generic relation list. Current emitters contain only:

- `parent_id` duplicated as `Contains`;
- canonical order duplicated as `Precedes` (which has no live emitter); and
- one note reference duplicated as `References` and inverse `FootnoteFor`.

Parentage stays on the node. Ordered note references stay on `Note`.
Provision-reference outcomes stay in `ProvisionReferencesResult`; definition
uses stay in `DefinitionsResult`. A test-only projector may recreate old graph
relations while checking parity, but production does not retain them.

`StructureNode` keeps one stable ID, kind, Unicode-scalar range, origin,
derivation, optional label/locator/aliases, parent ID, source anchor, and
marker/content ranges. Preserve `display` and `heading` only on the current
instrument roles that emit and consume them until exact corpus evidence proves
they can be derived. Store neither copied text, depth, nor a generic level.
PDF page/line arrays, geometry, detector grammar/proof receipts, and artifact
payloads stay outside the node; format maps/sessions resolve stable node or
fact IDs back to one or more source extents and artifacts.

Add exact node roles only with a live producer. The known required roles are
physical page/prose/heading, logical numbered paragraph,
article/part/division/section/subsection/schedule, list/list item,
table/row/cell, and footnote/endnote. Similar ranges do not make roles
identical: physical prose is not a logical numbered paragraph, a heading is
not automatically an addressable section, and a TOC advertisement is not a
body node. Delete the currently unpopulated generic `Navigation` role.

The named products retain full facts rather than summaries:

| Product | Required facts |
| --- | --- |
| `Note` | References one footnote/endnote node; the node owns ID/kind/label/body range/origin. `Note` owns occurrence/restart, paired or label-only state, ordered references and primary reference, per-reference proposition ranges, current capability-specific confidence/basis/warnings, typed body cross-references, and stable IDs that the format source map resolves to label/body/reference extents. |
| `InstrumentContentsReading` | Preserve the existing name and exact fields through parity, then enforce one `Present` or `Refused` state; entries preserve label/display/heading/page/source anchor/parent ID and remain separate from body nodes. |
| `DefinitionsResult` | Exact definition and use occurrence ranges, stable term, owning node IDs, source paragraph/artifact IDs |
| `ProvisionReferencesResult` | Exact occurrence, written label/word/plural/shape during literal port, normalized locator, continuation-head ID, source/target node IDs, resolved/external/unresolved/abstained status, exact reason, abstention evidence |
| Attachment/numbering results | Exact anchors, references, targets/outcomes, predecessor/current IDs, missing values, and duplicates needed to reproduce current lint |
| Diagnostics | Typed code/severity, semantic ranges, node/fact IDs, attributable origin; capability refusals stay in their named result. PDF artifact diagnostics retain current message/page/line/details outside canonical diagnostics until exact projection proves them derivable. TypeScript lint severity/message policy is not canonical. |

Counts, integrity summaries, self-loop flags, depth, page lists, note text,
human lint messages, excerpts, severity policy, and report caps are derived at
the consumer boundary.

The existing internal `DocumentInput` stays, contracted to source facts:

```rust
pub struct DocumentInput {
    pub document_id: String,
    pub text: String,
    pub source_sha256: Option<String>,
    pub scope: Scope,
    pub origins: Vec<Origin>,
    pub native_claims: Vec<NativeClaim>,
    pub coverage: Vec<Coverage>,
    pub exclusions: Vec<Exclusion>,
}
```

`Origin`, native claims, coverage, and exclusions remain input/audit facts, not
duplicate final structure. Prove across the complete provider differential
that `Origin.authority` and `NativeClaim.provider_order` affect no selection,
order, refusal, or projection before deleting them. Coverage may be
`Complete` only when the source explicitly establishes completeness for that
capability/range; complete with no claims means authoritative absence.
Exclusions name typed `NodeKind`s. The owning capability applies coverage and
exclusions; the operation receipt retains the audit evidence.

`assemble_document_structure` accepts this input plus final nodes and the named
typed products. It validates hashes, scalar bounds, unique IDs, origin/parent
foreign keys, parent acyclicity, and deterministic serialization. It rejects
duplicate IDs or ownership instead of hiding them through deduplication.
Capabilities own containment, conflict resolution, and deduplication policy.
The constructor does not scan text, score candidates, resolve labels, infer
parents, select native versus heuristic facts, apply coverage/exclusions, pair
notes, or interpret format geometry.

### Rust layout

The mechanical split is complete: `lib.rs` fell from 7,313 to under 900
lines without changing behavior. Keep the modules that now match real
responsibilities:

```text
lib.rs              public types, validation, and dispatch
candidates.rs       existing PDF candidate resolver
derive.rs           existing provider/profile materialization
inference.rs        existing shared-text detector logic
instrument.rs       exact instrument lineation, hierarchy, and TOC
numeric_sequence.rs the two proved dynamic-programming callers
definitions.rs      defined-term facts
docx_numbering.rs   DOCX numbering facts
docx_lint.rs        DOCX structural facts
tables.rs           authoritative table facts
text.rs             shared coordinates and ECMAScript whitespace
a2aj.rs             existing A2AJ adapter
native_markup.rs    existing renderer/provider identities
journal.rs          existing journal adapters
source_doc.rs       current projector/serializer/index/range builder
tests.rs            crate-level behavior tests
```

Do not split these files again merely because one is large. Add or extract a
module only when a port or canonical cut gives it one cohesive responsibility
and deletes duplicated code. `text.rs` owns only the coordinate and whitespace
implementations proved identical; provider/rendered coordinate planes remain
local. Definitions, references, case, legislation, and canonical assembly earn
modules only when their literal ports delete duplication.

Do not create `detectors`, `strategies`, `profiles`, `rules`, plugin traits,
fact buses, or a general witness module. The current public witness/candidate
API is PDF-specific in its page/line requirements and has one caller; move it
private to PDF. A shared resolver is justified only after two live callers have
the same candidate, evidence, incompatibility, and refusal semantics, an exact
combined differential passes, and the extraction deletes more code than it
adds.

Likewise, retain `select_numeric_sequence` and other current shared helpers
only where their existing callers are exact. Do not turn a coincidental
monotonic sequence into the architecture.

### Beaver call path

The small `structureNative.ts` loader exposes the single Rust document-analysis
operation. `documentProjectionService.read()` remains the ingress for versioned
uploaded file bytes and invokes it after format extraction.
Provider adapters retain fetching, rendition choice, credentials, URLs,
licensing, and upstream cache policy, then invoke the same operation after
producing text, markup, and native facts. Do not add a host, protocol, sidecar,
provider-input union, or parallel analyzer. Rust opens no Beaver path, database,
or provider client.

Beaver changes are direct:

- Read/Grep/navigation query nodes and typed results.
- DOCX bytes enter Rust once; lint and table facts query that same native
  document. `DocxSession` remains mutation-only.
- Amendment code uses the before-version structure, mutates once, then analyzes
  the changed candidate once.
- Provider tools query provider-native structure instead of compiling an
  instrument from flattened text.
- PDF SourceDoc and lookups query the original parse result.
- The A2AJ provider cache retains the fetched provider document and its one
  canonical native document handle; it is rebuilt, not migrated.

SourceDoc queries and navigation are Rust operations on the opaque native
document. Keep only product-owned legal-source linking, evidence verification,
URL policy, persistence, and mutation code in TypeScript.

## Execution rule

Every slice uses the same short loop:

1. Freeze the untouched implementation's complete output for that slice.
2. Port the mature logic literally into its final Rust owner.
3. Run one differential that reports all mismatches grouped by field, reason,
   and document, with a first divergent tuple and capped examples.
4. Fix mismatch classes without redesigning the algorithm or rebuilding for
   every single document.
5. Rewire all production callers and delete the old path in the same cut.
6. Run the slice's full corpus gate and record cold/warm performance.

Each completed vertical cut must leave tracked source-and-test line count at
or below its starting point; record the Git numstat with the parity receipt.

Legacy code may exist only as an independent experiment/test oracle until its
cut passes. No production old/new coexistence is introduced. A repair begins
from a named mismatch or measured hotspot, not from an architectural hunch.
Reuse existing harnesses and durable corpus inputs; store hashes/manifests and
capped mismatch diagnostics, while raw generated outputs remain ignored.

Parity and truth remain separate. A frozen corpus blocks unexplained drift;
it does not certify that the old detector was accurate. Independent gold,
source-native facts, and product invariants decide deliberate improvements.

## Vertical cuts

### 0. Lock executable gates

Already restored in the current worktree:

- the exact current projection-boundary import ratchet;
- the immutable 24-vector provider oracle; and
- the installed-provider receipt verifier, which self-checks 386 files,
  29,682,033 bytes, and 323,374 rows without regenerating the oracle. This
  validates the frozen receipt, not a current candidate.

Before the first affected production edit:

- make the checked-in 18-document Canadian structure gold and 79 pinned USLM
  documents executable exact comparators; and
- extend the existing PDF harness with normalized, hash-only receipts for the
  full graph, complete `LegalDocument`, final SourceDoc, and a checked-in lookup
  manifest. Pin source name, cold cache state, engine/cache identity, and field
  order; test warm/cold operation receipts separately.

The 872-text Rust product freeze is executable. Its paired-oracle mode matched
every retained historical TypeScript product on all 872 inputs; a green Rust-
only replay remains only the cheaper regression gate.

Before definition/reference or DOCX work, inventory every eligible available
DOCX into one committed manifest with an exact count and hash, then freeze
hash-only whole reports and every PDF/DOCX proposition output. The current 24
byte-unique files remain only a smoke ratchet.

Record each old TypeScript median with its owning freeze, before that detector
is deleted. Raw generated artifacts remain ignored.

### 1. Canonical core and provider-native cut

Change:

- evolve `StructureGraphV2` directly into the locked `DocumentStructure`;
- contract `DocumentInput`, add the policy-free assembler, and use one
  `ScalarText` per semantic text;
- remove boundaries, graph status, generic relations, `original_claims`,
  duplicated parent/edge materialization, and SourceDoc round-trip state;
- make the existing A2AJ, native-markup, and journal lanes emit one canonical
  native document containing their nodes, products, and SourceDoc in one pass;
- make TNA cited-ref extraction part of the existing markup traversal; and
- expose only the generated typed Node operation.

Proof:

- 24-vector fast oracle;
- **installed-provider corpus-scale gate: 323,374 exact rows**—248,685 A2AJ,
  55,504 CourtListener, and 19,185 journal rows—with zero unexplained
  mismatches;
- 18 Canadian and 79 USLM exact comparators;
- exact SourceDoc bytes, omissions/nulls, property order, UTF-16 offsets,
  indexes/ranges, and lookups; and
- `legal-structure` all-features tests and grammar-table check.

Delete after proof: provider SourceDoc-only ownership, graph/original-block
reconciliation, duplicate TypeScript projectors, the untyped command route,
and any source-structure adapter/engine/host whose boundary entry has reached
zero consumers.

### 2. Instrument, DOCX, and table cut

Change:

- keep the already-exact Rust lineation/hierarchy and assemble only the winning
  reading;
- differential the live TypeScript TOC against the unused Rust TOC and keep
  one exact Rust implementation;
- port definitions/uses and provision-reference detection/resolution literally,
  including external context, aliases, ambiguity, reach/integrity abstention,
  and exact reasons;
- accept existing DOCX/grid table facts and emit table/row/cell nodes without
  re-extracting cells;
- port exact attachment and numbering facts needed by lint; and
- route plain text, DOCX, spreadsheets, assistant reads, lint, mutation, and
  navigation through the one projection service call.

Proof:

- the instrument gate over **872 documents**: 124 agreements plus 748 settled
  extraction texts, comparing every typed result rather than totals;
- all available registered DOCX reports and focused definition/reference/
  TOC/table/numbering/attachment fixtures;
- amendment delete/renumber before-and-after outputs;
- the 23,531 English-statute source-lineation slice; and
- Unicode scalar-to-UTF-16 vectors.

This 748-text instrument lane is not the provider corpus-scale gate and is not
the PDF full-product gate.

Deleted in this cut: `legalTextSkeleton.ts`, `legalCrossReference.ts`,
`legalReferenceGrammar.ts`, detector/XML-reparse portions of
`docxStructuralLint.ts`, duplicate SourceDoc constructors, stored skeleton
summaries, and repeated instrument compiles.

### 3. PDF cut

The one PDF operation takes the complete `ExtractedPdf` and returns structure,
PDF source map, optional SourceDoc, and optional pairing audit. `LegalDocument`
is only the aggregate shell for PDF artifacts, that map, the canonical result,
the optional projection, and the operation/cache receipt.

Change:

- keep one ordered raw-line/text index and one semantic linearization buffer;
- add explicit line-local/raw-scalar/semantic-scalar mappings;
- compute typed line facts and protected citation spans once;
- keep PDF heading/page/list/note detection and candidate search private;
- collapse `Footnote`, anchors, pair claims, markers, graph notes, and summaries
  into one typed paired-note result plus optional audit;
- preserve physical page index, physical number, and printed folio as distinct;
- preserve physical prose, logical numbered paragraphs, headings, and sections
  as distinct roles;
- pass authoritative tables/images through and reference them without copying
  geometry/cells; and
- project SourceDoc from the returned structure/source map without a second
  parse.

Freeze before editing because the current `FrozenReplay` omits them:

- all 748 complete `LegalDocument` products, including structure, tables,
  images, diagnostics, metadata/provenance, repairs, and identity;
- all 748 final TypeScript-rehydrated SourceDocs;
- a fixed lookup corpus for every locator/status/context case;
- all 1,221,262 protected-citation line spans; and
- PDF and DOCX proposition results, including multiple note references.

Proof uses three distinct controls:

- **PDF derivation ratchet:** 748 cached native extractions, 24,707 pages, and
  1,221,262 lines, exact from settled common input;
- independent role/note/table/image/proposition truth and the
  100-article/6,443-row note-pairing receipt; and
- **PDF end-to-end product gate:** 1,500 PDFs / 111,542 pages—750 digital-born
  and 750 non-digital/OCR—covering extraction and routing that the 748 cache
  cannot prove.

Delete after proof: public candidate/witness protocol, duplicate paragraph and
note DTOs/materializers, `marker_summary`, inverse note relations, PDF-specific
SourceDoc/index/lookup projectors, later `source_doc` and `structure_lookup`
parse operations, replay-only production branches, and Beaver's PDF
child-process/temporary-JSON choreography. Keep private pair-search state and
the optional audit.

### 4. Consumer, cache, and external closure

- Route uploaded files and bounded mutation candidates through
  `documentProjectionService.read()`, and acquired provider sources through
  their existing fetch adapters; both invoke the same typed structure host
  exactly once before their consumers run.
- Rebuild the A2AJ structure cache producer and reader together around
  `DocumentStructure`; preserve current content identity, progress, resume,
  atomic promotion, and local/cloud persistence boundaries.
- Replace AuthoritiesHelper, citator, and stress JSONL callers with the thin
  Python binding. **Done:** the binding is in-process and the JSONL bridge and
  client are deleted.
- Delete `sourceDoc.ts` after moving its live queries to Rust. **Done.**
- Drive `documentProjectionBoundary.test.ts`'s exact allowlist to zero legacy
  bypasses.

Delete `legalStructureSidecar.ts`, `sourceStructureAdapter.ts`,
`sourceStructureEngine.ts`, `sourceDocStructureHost.ts`, handwritten
`structureWire.ts`, old cache schema/readers, `sourcedoc-jsonl.ts`, and
`sourcedoc_client.py`. Keep `structureNative.ts` as the sole small loader and
wire declaration for the opaque Rust handle; it contains no detector,
projector, cache, or duplicate model. Delete an entry only when `rg` and the
boundary test prove its last live consumer is gone.

### 5. Performance and release

Record the old TypeScript median before each detector is deleted, using the
same in-memory inputs. Measure separately:

- detector/assembly time;
- binding/serialization time;
- Beaver end-to-end time;
- cold and warm runs; and
- peak memory on the full gate.

The Rust detector lane must beat the old TypeScript median on the same work,
and the one-call Beaver path must not regress end-to-end latency. Profile a
measured hotspot before optimizing it. The existing PDF derivation target
remains at least 1,000 pages/second; a fast incomplete serializer does not
count. Build once per mismatch batch, use warm targeted tests during repair,
and run full Cargo/release gates only at slice checkpoints.

Final checks:

```powershell
node packages/legal-grammar-tables/check.mjs
cargo test --manifest-path legal-pdf-parser/Cargo.toml --offline --locked -p legal-structure --all-features
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 smoke -WithTableOfAuthorities
```

Also run the full provider, instrument, DOCX, PDF derivation, PDF end-to-end,
SourceDoc, lookup, and projection-boundary gates named above.

## Follow-ons kept, not prebuilt

After this refactor:

- Phase 3 retains the digital-born/OCR split and bounded Luna repair producer.
  Repairs remain anchored, typed, validated, provenance-bearing, and opt-in;
  flattened OCR text never becomes an excuse to redetect provider facts.
- Citation structure adds its actual typed product only when its literal port
  lands. Protected spans, provision references, parsed citations, note-body
  cross-references, and citation splitting remain distinct until an exact
  comparison proves otherwise.
- The ALR quote-verifier port remains required after the shared structure cut.
- Phase 4 retains the authored citation/split gold and acceptance program.

These are detailed in the retained evidence document. Do not scaffold generic
slots, model interfaces, or registries for them now.

## Done

The refactor is complete only when:

- every document version produces one canonical Rust result in one call;
- provider-native facts and every mature detector capability are preserved;
- each semantic fact has one internal owner;
- SourceDoc is an optional projection, not a second architecture;
- Beaver contains no structure detector or repeated parse/compile path;
- all named exact corpus gates pass, including the 323,374-row provider gate;
- independent truth gates show no structure-quality regression;
- old implementations, sidecars, wire protocols, duplicate materializers, and
  bypass imports are deleted; and
- the measured Rust/one-call path meets the performance requirements.

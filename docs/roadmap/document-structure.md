# Shared document structure

Status/order/gates: [master plan](master-plan.md). One standalone Rust
`legal-structure` engine, opaque NativeDocument and canonical DocumentStructure.
Beaver acquires immutable bytes/provider records and requests only the bounded
text/range/table/citation/navigation/mutation product needed; purpose-specific
operations do not derive unrelated structure.

Evidence: [structure inventory](../decisions/document-structure-evidence.md),
[cutover results](../decisions/source-structure-cutover-results.md), and
[parser parity inventory](../../legal-pdf-parser/experiments/structure-engine-parity/EVIDENCE.md).
Superseded plans remain at Beaver `54f89938` and parser `2b2c341e`.

## Profile-preserving refactor contract

Revised 2026-09-05. This section replaces earlier guidance to resolve structure
"locally, never by document genre" or to replace document profiles with a
universal candidate resolver. Profiles are overwhelmingly the correct policy
boundary. The refactor removes accidental implementation dependencies while
preserving the primary structure of each document, not flattening all detected
numbering into equally authoritative structure.

- An ordinary document has a primary structural profile governing its own
  paragraphs, sections, numbering, and interpretation of subordinate content.
  A profile is semantic policy, not just a hint to discard when a local sequence
  resembles another genre. Validated source metadata and native structure can
  establish it; absent reliable evidence, preserve uncertainty rather than
  inventing a confident classification.
- Quoted legislation, agreements, reasons, and other embedded passages may have
  internal structure. Their numbering does not become the enclosing document's
  paragraph/section spine or create a new peer document. Preserve quotation
  containment and source attribution when supported. Do not infer quotation or
  document boundaries from numbering or typography alone.
- A compound record has package structure and constituent documents occupying
  bounded spans, each with its own primary profile. A motion record's tabs,
  exhibits, and appended decisions are a separate boundary problem, not ordinary
  local role resolution. A tab may group multiple documents; a page break,
  numbering restart, or style change alone does not establish a constituent.
- Local evidence resolves roles within that ownership and profile context.
  It may expose a conflict or support a boundary for further validation; it
  must not silently switch the governing profile for each numbered run.
- Navigation and references must distinguish package locators, constituent
  locators, and quoted internal labels. Repeated paragraph 1s in separate
  documents must not collide; quoted section 5 must not satisfy a request for
  section 5 of the enclosing document. Preserve physical pages and source ranges
  independently of printed pagination and semantic numbering.

## Implementation sequence

These are planned changes, not claims that compound-document support is complete.
Preserve the existing release gates below; each stage must leave a usable engine.

1. **Freeze behavior and trace policy ownership.** Inventory the live adapters,
   profile selection, `inferred_blocks`, `detect_paragraphs`, candidate resolver,
   assembly, and query consumers. Record where profile choices, quotation
   exclusions, native claims, numbering scopes, and source ranges originate and
   where each is consumed. Freeze independently pinned complete outputs and
   production-route timing/memory before editing semantics. Reuse existing
   corpora and primitives; identify missing quotation/compound gold explicitly.
2. **Separate mechanics from policy without changing results.** Keep the current
   profiles and their proven acceptance/refusal rules. Share identical coordinate,
   grammar, validation, and assembly mechanics; keep profile-specific sequence
   selection, ambiguity rules, and native format witnesses explicit. Do not force
   non-PDF callers to fabricate page/line evidence. Route real callers through
   existing typed inputs, with no detector registry, universal evidence bag, or
   replacement semantic graph. Require exact full-output parity for this stage.
3. **Make enclosing versus quoted ownership reliable.** First audit existing
   containment, exclusions, coverage, and provenance contracts. Extend them only
   where a demonstrated product outcome cannot be expressed. Preserve quoted
   content for exact reading/search while preventing its numbering from taking
   over primary navigation or reference resolution. Fix all affected producers
   and consumers together. Any intentional correction needs independently
   reviewed expected output, not a regenerated baseline that blesses the change.
4. **Design and gate compound records separately.** Before implementing a split,
   establish reviewed boundaries on real motion records and combined submissions,
   including tabs that contain several documents, unmarked attachments, excerpts,
   repeated pagination, and cross-page boundaries. Determine which existing
   source manifests, bookmarks, tab destinations, native boundaries, and content
   evidence actually establish identity and extent. Specify package/constituent
   ownership, bounded primary profiles, offset mapping, reference scope, and
   behavior when boundaries remain ambiguous. Reuse the canonical document and
   persistence contracts; no parallel package store or speculative segmentation
   framework. If evidence is insufficient, retain exact page/text access and
   report uncertain boundaries without manufacturing peer documents.
5. **Cut over and publish a verified combination.** Exercise ingestion, saved
   artifact reopening, bounded reads, navigation, citations, notes, tables, and
   references through every affected consumer. Remove superseded production
   paths in the same cut, preserving capabilities. Enforce query/document
   identity where lazy indexes currently depend on caller discipline. Check
   both local path overrides and published Git pins; release only matching,
   gated structure/parser/Inspector/Beaver identities.

### Additional acceptance cases

Use reviewed real-document cases, supplemented by small behavioral tests:

- A judgment quoting numbered statutory or contractual provisions retains its
  own paragraph spine; quoted numbering remains subordinate and readable.
- Long quotations, nested lists, and appended material cannot displace the
  primary spine merely by winning a document-wide sequence/length ranking.
- A genuine constituent boundary establishes a new bounded primary profile;
  a quotation, ordinary heading, page break, or restart does not do so alone.
- A motion record preserves package tabs, constituent identity and extent,
  repeated local locators, and exact physical-page/text mapping on reopening.
- Ambiguous quotations or constituent boundaries preserve source facts and
  disclose uncertainty instead of silently promoting numbering.

Report quotation and compound-boundary accuracy separately from detector parity.
Existing corpus gates cannot prove these new distinctions unless their expected
products actually include them. No corpus counts or passing receipts may be
claimed for unreviewed compound gold. Do not weaken existing profile fidelity,
throughput, memory, or authoritative-source preservation to pass new cases.

## Ownership and cutover

- Rust owns semantic text, stable IDs/nodes/notes/definitions/references/tables,
  diagnostics, shared grammars and bounded queries. Adapters preserve native
  markup/IDs/locators/coverage/provenance; never flatten authoritative structure
  and redetect it.
- Parser owns PDF loading/geometry/images/OCR/rich witnesses and calls the pinned
  structure crate in-process, producing the same native document, not a second
  graph. Beaver owns fetching/versions/persistence/evidence/mutation policy/UI.
- Retain format-specific semantics: PDF geometry, DOCX XML/session state, grids,
  instrument refusal and provider coverage are not a generic fact bag. Share
  neutral evidence only where two live contracts really coincide and code shrinks.
- Node has one small typed loader/wire boundary. Handles in, requested product out;
  no TS detector/resolver/projector/cache/semantic mirror, SourceDoc/navigator/
  sidecar/baked skeleton, intermediate JSON protocol or forwarding service.
  Durable native artifacts may reopen a handle, never a parallel TS graph.
- Deduplicate identical byte/scalar/UTF-16 coordinates with explicit planes/
  rounding, exact ECMAScript whitespace, shared grammars/normalization, stable
  assembly/validation and queries. Keep differing ambiguity/refusal rules separate;
  no detector traits/registries/strategy hierarchies/witness buses.
- Per cut trace producers/consumers, port mature behavior literally, compare
  complete corpus products by mismatch class, rewire all callers and delete
  duplicates/test-only/compatibility paths. Independent evidence and explicit
  receipts justify quality changes; historical detector parity is not ground truth.

## Distinct fidelity gates

| Gate | Required corpus/product |
| --- | --- |
| Instrument | 872 detector inputs: 124 agreements + 748 settled extracted texts; complete instrument product. |
| Digital-born PDF ratchet | Separate 748 cached extractions, 24,707 pages/1,221,262 lines; complete derived PDF regression product, not comprehensive structure gold. |
| Full PDF lifecycle | Roughly 1,500 documents/111,542 pages: extraction/routing, digital and OCR, structure, page/line witnesses, tables/images, diagnostics and production rehydration. The ratchet cannot substitute. |
| Providers | Frozen 323,374 A2AJ/CourtListener/journal rows, 18 Canadian gold documents, 79 pinned USLM documents: native facts, UTF-16 ranges, exact lookup/bounded queries. |
| Other capabilities | Registered DOCX/table/numbering/definition/reference/citation/amendment corpora; complete typed products. |

Measure cold/warm detection, N-API/serialization, real ingestion/query throughput
and peak memory using production loading, not isolated loops. Require exact output
and materially improved replaced paths; tracked source/test LoC stable or lower.
Batch edits with warm affected-crate checks, then full candidate corpus/release
gates. Standalone Rust/Python use direct bindings; keep one Node addon.

## Release and retained follow-on requirements

- Publish/pin structure separately; advance parser/Inspector/Beaver only as the
  gated combination. Inspector remains one automatically synchronized branch
  with the smallest Beaver patch stack. No corpus/cache/generated/runtime commits.
- Preserve digital/OCR separation and optional bounded Luna repair: anchored,
  typed, validated and provenance-bearing. OCR never licenses redetection of
  authoritative provider facts.
- Finish literal citation ports; protected spans, provisions, parsed citations,
  note-body cross-references and splitting stay distinct absent exact shared proof.
  Preserve Phase 4 authored citation/split gold and acceptance.
- ALR Quote Verifier becomes a thin independent consumer after engine completion,
  not an engine copy or Beaver runtime dependency.

Done means every live consumer uses the one engine, all distinct gates pass,
there is no repeated parse/parallel semantics, LoC is stable or lower, and actual
production-route speed/memory improve. Further capabilities are not prebuilt.

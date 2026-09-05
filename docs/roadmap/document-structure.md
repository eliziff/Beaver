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

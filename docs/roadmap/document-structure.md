# Shared document structure

Status: active implementation plan

This is the only active plan for the structure refactor. Superseded plans remain
in Git at root commit `54f89938` and `legal-pdf-parser` commit `2b2c341e`.
Detailed detector inventories, parity evidence, witness analysis, and retained
follow-on work live in
[document-structure evidence](../decisions/document-structure-evidence.md),
[source-structure cutover results](../decisions/source-structure-cutover-results.md),
and the parser's
[evidence inventory](../../legal-pdf-parser/experiments/structure-engine-parity/EVIDENCE.md).

## Outcome

`legal-structure` is one standalone Rust engine for legal-document structure.
It preserves authoritative provider facts, runs the applicable mature detectors
where facts are missing, and owns one provider-neutral `DocumentStructure`
inside an opaque `NativeDocument`.

Beaver is a light consumer. It acquires immutable source bytes or provider
records, opens one native document, and asks Rust for the exact text, range,
table, citation, navigation, or mutation result it needs. A caller that only
needs a purpose-specific operation, such as citation scanning, calls that Rust
operation directly and does not derive unrelated headings, notes, or tables.

This replaces the old architecture outright. There is no TypeScript SourceDoc,
navigator, sidecar, baked skeleton, detector mirror, intermediate JSON
protocol, duplicated semantic model, compatibility phase, dual read/write, or
production-baseline restoration project.

## Architecture

```text
immutable source
  -> source adapter (native facts, provenance, text or complete PDF extraction)
  -> applicable Rust detector/assembler operations
  -> opaque NativeDocument
       owns one DocumentStructure
       retains only format artifacts needed for exact source queries
       answers bounded queries directly
```

### Ownership

- `legal-structure` owns semantic text, stable structure identities, nodes,
  notes, definitions, references, tables, diagnostics, shared grammars, and
  bounded queries.
- Source adapters own acquisition and the smallest translation needed to retain
  provider-native markup, identifiers, locators, coverage, and provenance.
  Native structure is trusted as source evidence; it is not flattened and
  crudely redetected.
- `legal-pdf-parser` owns PDF loading, page/line geometry, images, OCR routing,
  and the rich witnesses required for faithful PDF detection. It calls
  `legal-structure` in process and projects those facts directly into the same
  native document; it does not maintain a second semantic graph.
- Beaver owns versions, persistence, source/evidence links, provider fetching,
  mutation policy, and presentation. It does not parse legal structure.

Format-specific evidence stays specific when its semantics differ. PDF
geometry, DOCX XML/session state, spreadsheet grids, instrument refusal rules,
and provider coverage are not forced into a generic fact bag. Non-PDF lanes may
reuse a proven neutral evidence primitive, including witness-style selection,
only when doing so removes real duplication without weakening either lane.

### Rust API and Node boundary

Rust callers link the standalone crate and invoke the relevant constructor or
purpose-specific operation directly. `legal-pdf-parser` pins an exact gated
`legal-structure` revision and calls it without serialization or a subprocess.

Node has one small loader/wire file, `structureNative.ts`. Native constructors
return an opaque `NativeDocument` handle; bounded operations accept that handle
and return only their requested product. The TypeScript file may declare values
that actually cross N-API, but contains no detector, resolver, projector,
cache, semantic model mirror, or forwarding service. Provider and uploaded-file
callers are changed to use this boundary directly instead of preserving a bad
consumer shape.

`DocumentStructure` is the sole semantic representation. It is not serialized
into a second SourceDoc-shaped runtime model. Durable caches may serialize the
native product needed to reopen the same immutable version, but consumers query
the restored `NativeDocument`, not a parallel TypeScript graph.

### Internal reuse

Deduplicate only contracts that are actually identical:

- one text-coordinate implementation for byte, Unicode-scalar, and JavaScript
  UTF-16 positions, with explicit coordinate planes and rounding;
- one exact ECMAScript whitespace definition;
- shared compiled grammars and normalization where jurisdictions use the same
  language;
- one assembly/validation path for stable IDs, ranges, parents, hashes, and
  deterministic ordering; and
- one bounded query implementation over the canonical document.

Keep domain rules separate when their evidence, ambiguity, or refusal behavior
differs. A repeated regex or numeric sequence is a prompt to compare contracts,
not permission to invent a framework. Do not add detector traits, plugin
registries, strategy hierarchies, generic witness buses, or speculative result
slots. Extract a shared primitive only when at least two live callers are
semantically identical and the extraction reduces code.

## Execution

Work in complete, net-negative vertical cuts:

1. Trace every producer and consumer of the capability.
2. Preserve authoritative native facts and port the mature behavior literally.
3. Compare complete outputs on the applicable corpus, with diagnostics grouped
   by mismatch class rather than one-document whack-a-mole.
4. Rewire all owned consumers to the smallest Rust call that serves them.
5. Delete the displaced TypeScript/Rust path, duplicate model, test-only caller,
   and compatibility code in the same cut.
6. Batch edits before one narrow warm check; run full release and corpus gates
   only for a complete candidate.

Tracked source-and-test lines must remain stable or fall. Optimize measured
production paths, including document loading and the language boundary, not a
synthetic inner loop that omits live costs. Parity protects mature behavior; it
does not turn an imperfect historical detector into ground truth. Deliberate
quality changes require independent evidence and an explicit receipt.

## Fidelity and performance gates

These gates answer different questions and must not be conflated:

- **Instrument parity:** 872 detector inputs, including 124 agreements and 748
  settled extracted texts, compare the complete instrument product.
- **Digital-born PDF ratchet:** 748 cached digital-born extractions compare the
  complete derived PDF product across 24,707 pages and 1,221,262 lines. This is
  a regression ratchet, not comprehensive structure ground truth. It is a
  separate corpus from the 748 extracted texts within the instrument gate.
- **Full PDF lifecycle:** the much larger roughly 1,500-document corpus covers
  roughly 111,542 pages of extraction, routing, digital-born and OCR documents,
  structure, page/line witnesses, tables/images, diagnostics, and production
  rehydration. It is the corpus-scale end-to-end gate; the 748-document ratchet
  is not a substitute.
- **Provider paths:** the frozen 323,374-row A2AJ/CourtListener/journal gate,
  18-document Canadian gold, and 79 pinned USLM documents compare
  provider-native facts, UTF-16 ranges, exact lookups, and bounded queries.
- **Other capabilities:** registered DOCX, table, numbering, definition,
  reference, citation, and amendment corpora compare their full typed products.

Benchmark cold and warm detector time, N-API/serialization cost, real Beaver
ingestion/query latency, throughput, and peak memory. Use the same operations
and document-loading route that production uses. The Rust candidate must retain
exact output while materially outperforming the implementation it replaces.

## Release shape

- Publish `legal-structure` as its own repository and pin exact revisions from
  `legal-pdf-parser` and Beaver.
- Keep PDF Inspector as the single automatically synchronized
  `pdf-inspector` branch in `legal-pdf-parser`; gate updates before advancing the
  pin and keep Beaver-specific fidelity changes in the smallest patch stack.
- Keep one native addon boundary for Beaver. Rust/Python consumers use direct
  crate/binding operations rather than a JSONL bridge.
- Commit no downloaded corpus, cache, generated product, credential, or managed
  runtime.

## Retained follow-on work

The current cut does not erase or prebuild later capabilities:

- Preserve the digital-born/OCR split and bounded Luna repair work. Repairs
  remain anchored, typed, validated, provenance-bearing, and opt-in; OCR text
  does not justify redetecting authoritative provider structure.
- Finish citation structure through literal, typed ports and corpus evidence.
  Protected spans, provision references, parsed citations, note-body
  cross-references, and citation splitting remain distinct until exact evidence
  proves a shared seam.
- Port the ALR Quote Verifier as a thin independent consumer after the shared
  engine is complete; it must not copy the engine or become a Beaver runtime
  dependency.
- Preserve Phase 4's authored citation/split gold and acceptance program.

## Done

The refactor is complete when every live producer and consumer uses the
standalone Rust engine; each semantic fact has one owner; provider-native and
mature detector behavior survives the applicable full-corpus gate; the three
distinct instrument/PDF gates above pass; Beaver contains no parallel structure
stack or repeated parse; the language boundary is one small typed loader around
opaque native documents and direct operations; tracked LoC is stable or lower;
and production-route speed and memory are measurably improved.

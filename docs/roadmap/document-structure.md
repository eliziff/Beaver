# Shared document structure

Status: active replacement plan

Supersedes the structure plans at root commit `54f89938` and
`legal-pdf-parser` commit `2b2c341e`. Git history retains their detail; they
are not active architecture.

Supporting measurements and detector/citation/OCR/ALR requirements remain in
[Document-structure evidence](../decisions/document-structure-evidence.md),
[source-structure cutover results](../decisions/source-structure-cutover-results.md),
and the parser parity gate's
[evidence inventory](../../legal-pdf-parser/experiments/structure-engine-parity/EVIDENCE.md).

## Outcome

Build one small Rust library that accepts source text plus trustworthy native
facts and returns one canonical `DocumentStructure`. The same analysis can
optionally project a `SourceDoc`. PDF, DOCX, spreadsheets, provider records,
and plain text use the same detector implementations wherever they ask the
same structural question.

Beaver calls that library once per immutable document version. Its tools,
navigation, linting, retrieval, and citation code query or project the returned
structure; they do not run detectors or call separate native helpers.

No detector may become less accurate to make the design smaller. Existing
consumer DTOs and call patterns may be replaced when they force duplication or
bad coupling.

Today this is split across the TypeScript skeleton/reference/adapter modules,
granular Node exports, a large Rust inference module, separate A2AJ and native
markup composers, and both graph and SourceDoc materializers. TypeScript still
owns real detections while Rust results cross the binding more than once. None
of those module boundaries is a target to preserve.

## Boundary

```text
source record / PDF facts / DOCX facts
        |
        v
thin evidence adapter  ->  analyze_document  ->  DocumentStructure
                                                |       |
                                                |       +-> structure queries
                                                +----------> optional SourceDoc
```

Provider-specific code is allowed only at the edges:

- Ingress adapters translate provider-native sections, pages, notes, tables,
  exclusions, provenance, and locators into canonical evidence. Native facts
  are preserved; the core does not crudely rediscover them from flat text.
- Egress adapters attach provider URLs or project a consumer representation.
- Adapters do not own fallback regexes, lineation, hierarchy, reference,
  definition, list, table, note, or navigation detectors.

The core owns normalization, shared scans, candidate construction, evidence
resolution, abstention, diagnostics, and materialization. A domain may add
typed evidence or policy to a shared detector; it does not get a copied
detector. PDF geometry, for example, strengthens the shared heading/list/table
resolver without creating a second text-structure engine.

`DocumentStructure` is the only internal result. It contains ordered nodes and
ranges, parentage, labels and aliases, pages, headings, provisions, schedules,
lists, tables, notes, definitions, references, contents/navigation facts,
provenance, abstentions, and detector diagnostics. Derivable duplicate
relations and summary objects are not stored. `SourceDoc` is a projection, not
a second detected representation.

The Node boundary exposes one document operation. Request fields describe
source facts and available evidence, not which consumer is calling or which
detector choreography to execute.

## Internal shape

Keep domain detail, but factor the mechanics it shares:

1. One validated text/range space and one offset conversion at the binding.
2. One line/token/grammar scan that emits reusable typed matches.
3. Detector modules for candidate families: pages and paragraphs; headings,
   provisions and schedules; lists; tables; notes; definitions; references;
   and contents/navigation.
4. One resolver that combines native claims, text candidates, PDF/layout
   witnesses, exclusions, and profile policy into accepted nodes or typed
   abstentions.
5. One materializer for `DocumentStructure`, plus query and SourceDoc
   projections that add no detections.

The intended code shape is correspondingly small: text/range indexing,
evidence types, detector-family modules, one resolver, the canonical document
model, projections/queries, and edge adapters. Provider names and Beaver tool
names do not appear in detector modules.

Profiles express real semantic differences such as case paragraph numbering,
legislation hierarchy, or instrument lineation. They select policy and
admissible evidence inside the shared pipeline; they are not provider silos.

## Port discipline

The current hybrid is an oracle and a map of behavior, not an architecture to
preserve.

1. Inventory every production detector and every consumer. For each detector,
   record its authoritative implementation, inputs, outputs, diagnostics,
   domain-specific rules, fixtures, corpus gate, and duplicate implementations.
2. Freeze complete legacy outputs at the real seams before changing behavior.
   Where no ground truth exists, parity is a regression ratchet, not a claim of
   correctness. Gold or manual audit remains the quality gate.
3. Port one mature detector family literally into Rust. Reuse its actual
   algorithm and grammar; do not replace it with a convenient heuristic or a
   third interpretation.
4. Add stage diagnostics before corpus debugging: candidate counts, rejection
   reasons, selected runs, witness contributions, and grouped mismatch
   signatures. A differential reports all mismatch classes in one run, not
   only the first differing document.
5. Prove that family at unit-vector, seam, and corpus scale. Then factor common
   mechanics with already-ported families, rerunning exact parity after each
   contraction.
6. Once all families share the core, route every source adapter through it and
   prove the final `DocumentStructure` and optional SourceDoc at the
   TypeScript/Rust handoff.
7. Replace Beaver's calls in one vertical cut. Delete granular native exports,
   TypeScript detectors, duplicate graphs/summaries, compatibility DTOs, and
   transition tests in the same change.

Do not redesign a detector while porting it. Intentional quality improvements
come afterward, with explicit gold/audit evidence and a separately approved
baseline change.

## Beaver call procedure

`documentProjectionService` is Beaver's sole host for document analysis. It
constructs canonical evidence from the source compiler/provider adapter and
invokes Rust once under the existing immutable projection identity. The
application operation returns the canonical structure and, only when needed,
its SourceDoc projection.

All consumers use a small query surface over that result: resolve a locator,
read a node/subtree/range, enumerate children or siblings, follow references,
read definitions or contents, and project SourceDoc. A consumer that needs a
new view adds a query or projection; it does not add analyzer flags, a second
representation, or a direct native call. Consumer code may be simplified or
rewritten to fit this procedure, provided its useful public capability is
preserved.

## Gates

The edit loop is deliberately cheap:

- format only touched Rust files;
- run targeted detector tests, then `cargo quick`;
- build the native release artifact only for a seam or behavioral gate;
- compile once and run warmed, in-process differentials; never rebuild per
  document or serialize giant temporary outputs merely to compare them;
- long gates emit progress and resumable compact receipts.

Parity gates cover the authored grammar vectors, provider fixtures and frozen
rows, 124 agreements, the 23,531-document English A2AJ statute corpus, the
748-document PDF derivation corpus (24,707 pages), native-markup/journal cases,
DOCX and spreadsheet tables, Unicode/range failures, and public Beaver lookup
behavior. Require zero unexplained changes. The 748-document gate preserves
the prior detector where there is no complete ground truth; it does not certify
perfect structure.

Performance is measured after one warm-up and over five runs with corpus I/O
excluded and caches controlled. The final Rust path must use one native call
and one input transfer per document, improve warmed median throughput by at
least 20% over the complete TypeScript oracle, keep p95 latency within 5%, and
keep peak RSS within 10%. Warm `cargo quick` targets a two-second median and
four-second p95. A slow edit loop or a slow candidate is profiled immediately,
not normalized as the cost of Rust.

## Phase 3 — digital-born, OCR, and Luna evidence

The core port does not collapse digital-born and OCR extraction into one
quality claim. Digital-born text remains immutable native evidence. Scanned or
image-only pages use the registered local OCR lane and retain page, line, word,
geometry, confidence, order, and model provenance. The acquisition, model
selection, silver, and 1,500-PDF program remain governed by
`experiments/legal_pdf_corpus/LEGAL_PDF_SILVER_MASTER_PLAN.md`.

Both lanes feed the same structure evidence contract. Existing deterministic
region, ordering, furniture, table, heading, and note-pair results are passed
through as typed evidence; the shared analyzer must not approximate them from
flattened OCR text. OCR may propose corrected text only through an anchored,
validated replacement operation.

Luna is the bounded repair producer for unresolved OCR/layout contradictions,
invoked by the host through its existing model runtime. It receives immutable
anchors and existing deterministic candidates, not a blank page and a request
to rediscover structure. Its operations must be schema-valid, anchor-complete,
deterministically checked, and recorded with model/prompt identity before they
become evidence. Rust imports no model SDK, and Luna never emits a competing
final SourceDoc or structure graph.

Phase 3 passes only when digital-born parity remains exact, the registered OCR
and 661-page ordered journal surfaces retain or improve every separately
reported transcription/order/region/note metric, anchor accounting is complete,
and held-out Luna repair improves or preserves the deterministic lane without
hiding cost inside the digital-born performance number.

## Phase 4 — consumer cutover, ALR parity, and deletion

Cut over in dependency order after the shared core and Phase 3 seam are proven:

1. Tag the shared Rust source and build every binding from that commit.
2. Point Legal PDF Parser at it, delete displaced format-neutral detectors,
   and rerun the full PDF gates.
3. Move Beaver, DOCX structure/linting, and citation linking to the one
   application call and query surface described above.
4. Move Authorities Helper to the shared citation/structure batches while
   retaining only its product and Word-document responsibilities.
5. Port ALR Quote Verifier as an independent thin consumer; delete its copied
   splitter, grammar, provider structure, and PDF implementations only after
   its own proof passes.
6. Update repository pins, manifests, release provenance, and architecture
   docs together, then run each repository's release suite.

There is no dual production period, compatibility alias, fallback parser, or
feature flag. Frozen implementations remain test oracles until their consumer
passes, then Git becomes the rollback mechanism.

ALR's no-regression proof covers its accepted 405-row citation-split gold,
quote matching and boundary refusals, proposition ranges and ordering, full
A2AJ and CourtListener structure modes, representative PDF intake, real DOCX
and workbook product outputs, offline packaging, runtime, and memory. A
previously correct result remains exact unless an independently adjudicated
fixture proves the replacement better. Slices cannot lose precision or recall
behind an aggregate gain; where there is no truth, require exact parity or
adjudicate every delta.

Phase 4 also exercises Beaver local/cloud document projection, Authorities,
DOCX, provider corpora, the 748-document PDF lane, and all repository release
checks against the same shared commit. Long runs retain compact progress and
failure receipts, not raw corpus copies.

## Done

- Every structural detector is Rust-owned or explicitly classified as source
  acquisition/non-structural work.
- Shared questions have one implementation; provider differences are typed
  evidence or edge projection only.
- Beaver has one analysis call path and no consumer imports a detector or
  granular native helper.
- Complete seam and corpus parity is green, quality gates have not regressed,
  and the performance gate passes.
- The old TypeScript/hybrid implementations and redundant representations are
  deleted. Git, not compatibility code, is the rollback path.

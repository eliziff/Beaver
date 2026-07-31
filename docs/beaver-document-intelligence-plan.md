# Beaver Document Intelligence Plan

> Status note (2026-07-26): this is a detailed design appendix. The
> authoritative implementation status and backlog are in the
> [Beaver master plan](beaver-master-plan.md). Some “current state”
> statements below predate the shared AppData store and standalone parser.

## Purpose

Turn Beaver's local Library into a persistent legal-document intelligence layer. A
PDF should be parsed once when it is imported, and later assistant requests
should retrieve exact structural units—such as footnote 62 and its supporting
proposition—without asking the model to reinterpret the whole PDF.

This remains a local, account-free Beaver deployment. Cloud storage is not
required. The reusable parsing component is specified separately in
[Universal Legal PDF Engine Plan](universal-legal-pdf-engine-plan.md).

## Current State

Beaver already has:

- Anonymous local Library storage under `.mike-local`.
- Codex model and reasoning-effort controls.
- Local assistant tools for listing, reading, and searching Library documents.
- A2AJ integration in `backend/src/lib/a2aj.ts`, `a2ajTools.ts`, and
  `localAssistantTools.ts`.

The current PDF path extracts flat text. Its small search index is held in
memory, so it neither preserves legal document structure nor provides stable,
exact footnote lookup.

The source projects already contain most of the required parsing work:

- Text-Fidelity-Project provides native PDF extraction, geometry-aware
  canonical packages, reading-order and region repair, r=1 Luna structural
  adjudication, and the production `footnote_pairing_v2` engine.
- ALR-Quote-Verifier's `verifier_core/pdf_adapter.py` already bridges the
  Text-Fidelity pipeline into stable footnote markers, handles restarted
  numbering, materializes note bodies, and produces parsed document records.
- ALR's `build_anchor_propositions` pairs each reference with either its
  containing sentence or the passage since the previous note.

## Intended User Experience

1. A user imports a PDF into the local Library.
2. Beaver immediately stores the original file and creates a durable parse job.
3. The deterministic parser builds page, paragraph, footnote, and proposition
   indexes in the background.
4. The Library shows parsing state: `queued`, `parsing`, `ready`, `degraded`, or
   `failed`.
5. Questions such as “What is footnote 62?” use exact lookup first.
6. The assistant receives only the requested note, its reference location,
   paired proposition, and a small amount of surrounding text.
7. Full-document retrieval remains available when the question actually
   requires it.

Import succeeds once the original file is safely stored. A parser failure must
not make the document disappear or prevent ordinary text access.

## Persistent Document Artifacts

Every imported file receives a stable document ID and immutable version ID. A
new file hash creates a new version; rebuilding with a new parser creates new
derived artifacts for that same source version.

Store the following beneath Beaver's existing local data root:

```text
.mike-local/
  documents/<document-id>/
    versions/<version-id>/
      source.pdf
      source.pdf.legalpdf-state.json
      source.pdf.legalpdf/<parse-identity>/
        document.json
        pages.jsonl
        paragraphs.jsonl
        sections.jsonl
        footnotes.jsonl
        diagnostics.jsonl
        repairs.jsonl
        parser-config.json
```

`footnotes.jsonl` includes each paired note's sentence and
passage-since-prior-note proposition fields.

`document.json` records:

- Source SHA-256, byte length, MIME type, and import time.
- Parser, schema, prompt, model, and configuration versions.
- Artifact hashes and parse status.
- Whether results are deterministic, Codex-repaired, OCR-derived, or degraded.

The durable structured source preserves:

- Ordered page text, body paragraphs, headings, and reading order.
- Footnote/endnote references and bodies.
- Display labels and unique pair IDs so restarted numbering is unambiguous.
- Reference locations and paired propositions.
- Confidence, warnings, and repair provenance.

Regions, spans, words, and bounding boxes are parser working state. They remain
available in memory to geometry consumers such as PDF highlighting but are not
duplicated beside every stored PDF.

Use ordinary JSON and JSONL files for the first implementation. Beaver does not
need a new database merely to retrieve small, version-scoped records.

## Parsing Pipeline

### Deterministic first pass

1. Fingerprint the source and reuse its complete matching compact structural
   source when one exists.
2. Detect whether useful embedded text is present.
3. Run Text-Fidelity's native digital-born extraction and canonical-package
   construction.
4. Infer regions and reading order from geometry, font information, separators,
   and repeated page furniture.
5. Run `footnote_pairing_v2`.
6. Apply ALR's materialization logic to create stable note bodies and inline
   reference markers.
7. Build both proposition forms:
   - The sentence containing the note reference.
   - The passage since the preceding note reference.
8. Validate artifact consistency and publish the version atomically.

Image-only documents can initially use Beaver's existing text fallback or be
reported as requiring OCR. OCR is not a prerequisite for shipping the
digital-born path.

### Structural repair

Escalate only pages or article spans whose deterministic diagnostics identify
real structural uncertainty, including:

- Implausible reading order or column transitions.
- Unclassified or overlapping regions.
- Unmatched note references or bodies.
- Suspicious line coverage.
- Footnote blocks mixed into body prose.

Use the Text-Fidelity r=1 contract: previous page, target page, and next page.
The model may reorganize immutable source lines but may not invent, rewrite, or
drop their text. Validate the response before replay:

- Strict response schema.
- Every required source line represented exactly once.
- Stable line IDs.
- No glyph-content mutation.
- Valid region and ordering references.

Retry an invalid response up to three times. If all attempts fail, retain the
deterministic parse, mark the affected scope `degraded`, and expose the
diagnostics. This is an internal validation failure, not a model abstention.

The default repair model is `gpt-5.6-luna` at low effort. Model and effort must
remain configurable through the same dynamic Codex controls as the rest of
Beaver; no model name or supported effort list is hardcoded into this feature.

### Durable parse identity

Identify deterministic work by:

```text
source hash + parser version + schema version + deterministic configuration
```

Cache only bounded Codex repair calls by:

```text
source hash + selected context + prompt/schema version + model + effort
```

Partial or invalid structural sources are never reused. Publication is atomic.
The full geometry-rich parser document is transient; Beaver persists the
compact structural source and exact receipts. Re-importing an unchanged PDF
should perform no parsing or model calls.

### Implementation record (2026-07-30)

The canonical parser completed a three-worker, full local Canadian corpus run:
367,400 documents and 9,599,936,926 characters with zero parser errors. Against
the existing provider structure maps, the shipping parser reached 95.4721%
precision, 90.4193% recall, and 92.8770% F1; all three measures improved over
the prior laws run. The immutable run receipt has SHA-256
`1c640b664e2b4cbd028e0c49d38fe662886dfeb637099236f18be22f24d838f8`.

Beaver's compact publication was also measured through the real ingestion and
SourceDoc readers:

| PDF | Pages | Source | Full parser artifact | Compact source | Reduction | Full/compact median read |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Wastech | 67 | 386,296 B | 10,283,955 B | 962,750 B | 90.6% | 91 / 11 ms |
| Westport | 84 | 435,963 B | 5,963,519 B | 985,584 B | 83.5% | 49 / 14 ms |

Both profiles produced identical SourceDoc character and block counts. This is
why Beaver persists the compact source rather than compressing or caching the
geometry-rich parser working document.

## Assistant Tools

Keep the existing Library and A2AJ tools and add:

### `library_footnotes`

Input:

- `document_id`
- Optional page range or display label
- Optional result limit

Output:

- Pair ID
- Display label
- Reference and body page numbers
- Short body preview
- Parse provenance and confidence

### `library_footnote`

Input:

- `document_id`
- Either a unique pair ID or display label
- Optional page or occurrence hint when a label is repeated
- Optional proposition mode: `sentence` or `passage_since_prior_note`

Output:

- Exact footnote body
- Reference marker and location
- Paired proposition
- Small bounded context window
- Source version and parse provenance

If a label such as `62` is ambiguous, the tool returns the candidate
occurrences rather than silently selecting one. These tools retrieve structured
records directly and do not invoke Codex.

The assistant's tool guidance should prefer exact lookup for a named footnote,
then Library search, then broader document reading. A2AJ remains the source for
Canadian legislation and case law rather than being replaced by local search.

## Local Journal Connection

ALR's `data/public_endpoint.db` contains approximately 18,958 articles and
1.17 billion characters. Treat it as a read-only source corpus.

Build a separate, resumable derived index:

- Chunk by article and page while retaining journal, volume, issue, title,
  author, and source identifiers.
- Embed with multilingual-E5-small.
- Store vectors in TurboVec shards.
- Record source-database fingerprint, embedding model version, chunking version,
  and completed shard ranges.
- Resume interrupted indexing and publish only complete shards.
- Run indexing as a background administrative job, never as part of Beaver
  startup.

Expose:

- `journal_search`: semantic or metadata search returning bounded passages and
  source identifiers.
- `journal_fetch`: exact retrieval of a selected article/page passage.

This index is optional. Beaver, Library parsing, exact footnote lookup, and A2AJ
must continue working when it has not been built.

## Benchmark

### Gold data

Use the complete ordered manual-gold bundle on `oajd-desktop`:

```text
`TEXT_FIDELITY_PROJECT_ROOT` (local checkout)
output\multimodal_llm\manual_gold_bundles\
train1_12_full_manual_gold_ordered_db_reading_order_20260629_01
```

It contains 661 pages, 350 articles, 32,553 lines, 3,068 footnote regions,
PAGE XML reading order, page images, text, corrected/markerized outputs, and
footnote sidecars. Accept the bundle path as an input and fingerprint it; do not
assume that a later `_05` path exists.

Use the locked local footnote gold set:

```text
Text-Fidelity-Project\tools\footnotes\output\goldset\
target_1500_20260706_03
```

It includes 100 verified articles and 1,073 verified pages, with locked markers,
pairs, and visual inspections.

Use the 37 `.docx` files found in ALR-Quote-Verifier as an additional
source-of-truth corpus, prioritizing the canonical files under `data/inputs` and
`data/samples` and excluding duplicate `_temp` copies. Extract body order,
paragraphs, headings, footnote/endnote references and bodies, labels, and
propositions directly from OOXML as ground truth. Produce paired PDFs from each
DOCX using several recorded export profiles rather than assuming an ideal PDF:

- A normal native PDF export as the reference case.
- A print-oriented export with tags, bookmarks, and document-structure metadata
  disabled.
- A system print-to-PDF path that retains visible text but exposes less semantic
  structure.
- Where useful, a rasterized or otherwise text-poor export to exercise the OCR
  boundary separately.

Record the exporting application, version, settings, fonts, and output hash.
Score reconstruction against the DOCX's logical content and relationships, not
against identical pagination, because export profiles may reflow the document.
This track establishes how much structure survives—and how much the engine can
recover—when real PDFs are less rich than a good native export.

### Frozen evaluation set

Create a reproducible 80-page manifest from the manual gold:

- Include known structural faults and hard legal layouts.
- Stratify by journal/article and failure type.
- Include straightforward pages to measure regressions.
- Store page identifiers and gold-bundle fingerprint, not copied gold assets.
- Do not change the manifest after model evaluation begins.

The complete 661-page set remains the final confirmation run.

### Model arms

Run the same prompt, schema, page set, retry policy, and evaluator for:

1. `gpt-5.6-luna`, low effort.
2. `gpt-5.6-terra`, low effort.
3. `gpt-5.6-sol`, low effort.
4. `gpt-5.6-luna`, xhigh effort as the control.

An invalid result after three attempts is scored as a failure. There is no
explicit abstention option.

### Metrics

Report:

- Character and word error rates.
- Pairwise order, adjacent-order recall, and exact-position accuracy.
- Region boundary and type accuracy.
- Source-line conservation and schema-valid response rate.
- Footnote reference/body precision, recall, and F1.
- Correctness of both proposition-pairing modes.
- DOCX-grounded recovery of paragraphs, notes, propositions, and citation text
  across each deliberately degraded PDF export profile.
- Downstream exact-footnote lookup accuracy.
- Wall time, model latency, token usage, retries, and estimated cost.

Compare against the unchanged deterministic pipeline. Adopt a model arm only
when it improves the targeted structural and downstream measures without
material text-fidelity regression. Report the Pareto frontier rather than
hiding quality/cost tradeoffs in a single composite score.

## Delivery Sequence

1. Introduce the stable parsing contract and a read-only adapter around the
   existing Text-Fidelity and ALR code.
2. Persist deterministic artifacts during Library import.
3. Add exact footnote and proposition tools.
4. Add structural diagnostics and selective Codex repair.
5. Build and run the frozen benchmark before changing the default repair arm.
6. Add the optional journal index and tools.
7. Migrate existing Library PDFs lazily when first opened or explicitly
   reindexed.

Each phase leaves the previous Library behavior available as a degraded
fallback. No phase adds accounts or cloud storage.

## Acceptance Criteria

- Importing a supported digital-born PDF produces persistent structured
  artifacts that survive server restarts.
- Re-importing identical bytes performs no duplicate parse or Codex call.
- Beaver can retrieve a uniquely identified footnote and paired proposition
  without loading the full document.
- Restarted labels and symbol notes do not collide.
- Invalid repairs cannot alter source text or replace a valid deterministic
  artifact.
- Model and reasoning effort are independently selectable from the supported
  Codex CLI values.
- A2AJ tools continue to work unchanged.
- The frozen benchmark is reproducible from its manifest and records every
  model/configuration version.
- Beaver remains usable when the optional journal index or Codex is unavailable.

## Risks

- Malformed embedded fonts can produce plausible but incorrect text.
- Legal documents use restarted numbering, symbols, endnotes, and multi-page
  notes that defeat label-only lookup.
- Structural confidence can be falsely high; downstream pairing metrics must
  supplement parser diagnostics.
- Codex output and cost can change with model or prompt versions, so caches and
  benchmark results require explicit versioning.
- Local legal documents may be confidential; model-assisted repair must be an
  explicit local configuration and its use visible in provenance.
- ALR has an explicit license, while no top-level license was found in the
  inspected Text-Fidelity-Project checkout. Keep the first integration
  adapter-based and clarify reuse terms before distributing extracted code as
  a separate package.

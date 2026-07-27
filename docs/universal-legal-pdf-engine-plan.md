# Universal Legal PDF Engine Plan

> Status note (2026-07-26): the standalone engine now implements a substantial
> portion of this design. This file remains the detailed requirements and
> benchmark appendix; the authoritative remaining work is in the
> [Beaver master plan](beaver-master-plan.md).

## Purpose

Build a small, reusable engine that converts legal PDFs into stable text and
structural records. It should run locally on weak hardware for ordinary
digital-born PDFs and optionally use Codex only for structural cases that the
deterministic parser cannot resolve confidently.

The engine must not depend on Beaver, ALR-Quote-Verifier, or
TableOfAuthoritiesMaker. Those applications consume its output through thin
adapters. The first intended integration is described in
[Beaver Document Intelligence Plan](beaver-document-intelligence-plan.md).

## Existing Work to Reuse

### Text-Fidelity-Project

Use the existing implementations as the behavioral reference:

- `tools/galley/final_contract_v2/native_extraction.py` for native extraction.
- `digitalborn_native_product.py` for canonical package construction.
- `tools/footnotes/footnote_pairing_v2.py` for production footnote pairing.
- `tools/ocr/digitalborn/luna_semantic_adjudication.py` for r=1 structural
  repair.
- `replay_canonical_package_repairs.py` for validated repair replay.
- `score_canonical_packages_vs_ordered_gold.py` for structural evaluation.

The canonical-package approach already preserves geometry, line identity,
reading order, regions, and provenance. The universal engine should narrow and
stabilize that contract instead of starting another parser.

### ALR-Quote-Verifier

Use `verifier_core/pdf_adapter.py` and `alr_quote_verifier.py` as the application
reference for:

- Extracting PyMuPDF lines, bounding boxes, fonts, superscripts, and separators.
- Calling the Text-Fidelity footnote pairer.
- Materializing stable footnote bodies and inline `⟦FN:n⟧` markers.
- Handling restarted numbering through unique pair IDs.
- Pairing note references with sentence-level and
  passage-since-prior-note propositions.

ALR's existing PDF adapter tests provide the initial regression fixtures for
ordinary notes, restarted numbering, and symbol notes.

### TableOfAuthoritiesMaker

Its downstream pipeline already has a clean source-neutral seam:

- `extract_docx_units` supplies ordered body and footnote `TextUnit` records.
- `review_document` and `split_citations` operate on those records.

A PDF adapter should produce the same unit sequence. Citation detection, review
JSON, A2AJ lookup, and book generation do not need to know how the PDF was
parsed.

## Package Shape

Use a standalone Python package, tentatively named `legalpdf`, with PyMuPDF as
the only required PDF dependency. Reuse source modules through adapters during
the first implementation; do not fork large copies of either project.

The core has:

- An importable API.
- A thin command-line interface.
- JSON/JSONL artifacts.
- Optional Codex and OCR adapters.

It does not require a server, account, cloud store, database, vector index, task
queue, plugin system, or custom binary format.

## Public API

```python
def parse_pdf(
    path: str | Path,
    *,
    mode: Literal["local", "codex"] = "local",
    cache_dir: str | Path | None = None,
    model: str | None = None,
    effort: str | None = None,
) -> LegalDocument:
    ...

def improve(
    document: LegalDocument,
    pdf_path: str | Path,
    *,
    model: str,
    effort: str,
) -> LegalDocument:
    ...

def lookup_footnote(
    document: LegalDocument,
    label_or_pair_id: str,
    *,
    page: int | None = None,
    occurrence: int | None = None,
    proposition_mode: Literal[
        "sentence", "passage_since_prior_note"
    ] = "sentence",
) -> FootnoteLookup:
    ...
```

`mode="codex"` means deterministic parsing followed by selective repair. It
never means sending every page to a model.

Command-line equivalents:

```text
legalpdf parse FILE.pdf --output OUTPUT_DIR
legalpdf parse FILE.pdf --output OUTPUT_DIR --mode codex \
  --model MODEL --effort EFFORT
legalpdf improve FILE.pdf --document DOCUMENT.json --output OUTPUT_DIR \
  --model MODEL --effort EFFORT
legalpdf footnote DOCUMENT.json 62
```

The installed Codex CLI is the initial model transport. Callers supply supported
model and effort values; the engine does not maintain a hardcoded list.

## Output Contract

`LegalDocument` is serializable to `document.json` and references larger JSONL
collections by relative path.

### Document

- Schema version and document ID.
- Source filename, SHA-256, page count, and PDF metadata.
- Parser/configuration fingerprint.
- Parse status and aggregate diagnostics.
- Paths or embedded references to pages, regions, paragraphs, and notes.

### Page and text records

- Stable page, region, line, and span IDs.
- One-based display page and zero-based PDF page indexes.
- Bounding boxes in PDF coordinates.
- Immutable extracted text.
- Font and superscript information when available.
- Reading-order position.
- Region type such as body, heading, footnote, header, footer, or unknown.

### Footnote records

- Unique pair ID.
- Display label, including symbols.
- Reference line/region/page and body line/region/page ranges.
- Materialized note text.
- Restart sequence and occurrence number.
- Sentence proposition and passage-since-prior-note proposition.
- Pairing confidence, warnings, and provenance.

### Diagnostics and provenance

- Native-text quality signals.
- Unresolved reading-order or region faults.
- Unmatched references and bodies.
- OCR or Codex use.
- Repair model, effort, prompt/schema version, cache key, and validation result.
- Original and repaired artifact hashes.

Source text and derived structure remain separate. A structural repair may
change ordering, grouping, and types, but not the immutable extracted glyph
text.

## Local Profile

The default profile targets digital-born PDFs and runs sequentially to keep
memory predictable.

1. Hash the PDF and check the artifact cache.
2. Inspect each page for useful embedded text, replacement-character rate,
   suspicious font mappings, and text/image coverage.
3. Extract words, spans, fonts, bounding boxes, superscript signals, rules, and
   page geometry with PyMuPDF.
4. Detect repeated headers, footers, page numbers, and other page furniture.
5. Infer columns and reading order using geometry and the existing
   Text-Fidelity rules.
6. Classify headings, body blocks, and footnote/endnote regions.
7. Run the production footnote pairer.
8. Materialize notes and both proposition forms using ALR's proven logic.
9. Validate stable IDs, complete line coverage, and pair references.
10. Write artifacts to a temporary directory and publish them atomically.

The engine should stream JSONL records and discard completed page images and
temporary structures. It should not render every page unless diagnostics or OCR
requires it.

### Scanned PDFs

OCR is an optional adapter, not part of the minimal dependency set:

- Route pages with no usable embedded text to an installed local OCR provider.
- Convert OCR words/lines into the same geometry-aware input contract.
- Run the normal structural and footnote pipeline afterward.
- Mark OCR provenance and confidence prominently.
- Permit mixed native/OCR documents page by page.

The first release may return `ocr_required` when no provider is configured.
That is preferable to silently treating an empty extraction as a valid parse.

## Codex-Assisted Profile

### Escalation

Only escalate bounded problem scopes with concrete diagnostics:

- Conflicting column or reading order.
- Lines with incomplete or duplicate structural coverage.
- Footnote regions mixed with body text.
- Unmatched references or bodies near a plausible note boundary.
- Unresolved page-spanning notes.
- Severe region overlap or unknown-region density.

Group adjacent hard pages when they form one structural fault. Otherwise use one
target page with r=1 context: previous, target, and next page.

### Request contract

Provide:

- Rendered context pages when visual evidence is needed.
- Immutable line IDs, text, geometry, and current region/order assignments.
- Deterministic diagnostics.
- A strict response schema limited to ordering, grouping, and region typing.

The response contains no free-form replacement text and no abstention field.

### Validation and replay

Accept a response only if:

- It matches the exact schema.
- Every required source line appears exactly once.
- All referenced IDs exist.
- Immutable text is unchanged.
- Ordering and region references are internally consistent.

Retry invalid responses up to three times. Then keep the deterministic result
and record a failed repair. Replay valid structural operations onto the
canonical package and rerun region, footnote, and proposition derivation.

### Caching

Deterministic key:

```text
source hash + parser version + schema version + local configuration
```

Codex key:

```text
source hash + bounded context hash + prompt/schema version + model + effort
```

Never reuse invalid, partial, or manually cancelled calls. Cache metadata
includes token usage and latency so later benchmarks do not need to reconstruct
costs.

## Application Adapters

### Beaver

- Store engine artifacts with each Library document version.
- Map parse status into the Library UI.
- Expose exact footnote and proposition assistant tools.
- Keep existing flat-text retrieval as a degraded fallback.

### ALR-Quote-Verifier

- Replace the internals of its PDF adapter with conversion from
  `LegalDocument`.
- Preserve ALR's parsed-document interface, quote verification, and A2AJ logic.
- Run the existing PDF adapter tests unchanged where possible.

### TableOfAuthoritiesMaker

- Add a PDF input path beside `extract_docx_units`.
- Emit ordered body and footnote `TextUnit` values from `LegalDocument`.
- Add `.pdf` to the GUI file picker.
- Leave citation splitting, review state, A2AJ resolution, and book generation
  unchanged.

Adapters belong in each consuming application. The universal package must not
import application code.

## Benchmark

### Data

Use:

- The 661-page, 350-article ordered manual-gold bundle on `oajd-desktop`.
- The locked 100-article, 1,073-page footnote gold set in
  Text-Fidelity-Project.
- The suite of 37 `.docx` files found in ALR-Quote-Verifier, with canonical
  corpus members selected from `data/inputs` and `data/samples` and duplicate
  `_temp` copies excluded.
- ALR's existing synthetic PDF adapter fixtures.
- A small application-equivalence set covering Beaver lookup, ALR quote
  verification, and TableOfAuthoritiesMaker `TextUnit` generation.

Record the exact source fingerprint and manifest revision. Gold assets remain
outside this package.

### DOCX-grounded degraded-export track

Use the suite of `.docx` files in ALR-Quote-Verifier as structural ground truth
for their PDF equivalents. Read body order, paragraphs, headings,
footnote/endnote references and bodies, labels, propositions, and citation text
from OOXML. Do not assume a good or semantically rich PDF export. Deliberately
use poorer, less information-rich PDF export settings and measure what the
engine can still reconstruct.

Generate a reproducible export matrix:

1. Normal native PDF export as a reference ceiling.
2. Print-oriented export with accessibility tags, bookmarks, and document
   structure disabled.
3. System print-to-PDF output that preserves visible text but strips richer
   semantics.
4. A rasterized or otherwise text-poor variant for the optional OCR profile.

Record the exporting application and version, exact settings, installed-font
state, and hashes of the DOCX and PDF. Keep export generation separate from
engine execution so every parser/model arm receives identical PDF bytes.

Compare logical structure rather than page coordinates: degraded export can
change pagination and line wrapping without changing the correct paragraph,
footnote, proposition, or citation relationships. Report results by export
profile so a strong native export cannot conceal failures on poorer PDFs.

### Public cross-jurisdiction diversity track

Assign a research subagent to search the internet for and download a deliberately
diverse corpus of public American, Canadian, and UK legal PDFs, then run every
file through the frozen local parser. Prefer official court, tribunal,
legislative, and government repositories; record the source URL, access date,
jurisdiction, court/body, document class, language, apparent generation method,
license/terms note, byte hash, and page count in a resumable manifest. Do not
substitute search-result snippets for the actual PDF, and do not bulk-download
from a source whose terms prohibit it.

Stratify the corpus rather than taking only easy digital-born judgments:

- US federal and state courts, trial and appellate material, slip opinions,
  scanned reporter material, dockets/orders, and agency or tribunal decisions.
- Canadian federal, provincial, and territorial courts and tribunals, including
  bilingual and French documents, neutral-citation and older reporter formats.
- UK Supreme Court, Privy Council, appellate and first-instance courts,
  tribunals, and legislation or explanatory material.
- Native tagged PDFs, untagged digital-born PDFs, print-to-PDF files, image-only
  scans, mixed text/image documents, multi-column pages, appendices, tables,
  stamps, signatures, restarted numbering, deep sections/subsections, footnotes,
  endnotes, and marginal or running text.

Freeze a balanced discovery manifest before inspecting parser scores. Keep a
small manually audited diagnostic subset and a larger unattended robustness
set. For each file, retain parse status, extraction route, warnings, page and
region counts, ordering diagnostics, structure/footnote confidence, runtime,
peak memory, and any crash or timeout. Render representative failures so the
review is based on the PDF and output together.

After the run, cluster failures by root cause and improve the parser under a
complexity budget:

1. Add a regression fixture before each change.
2. Prefer tuning or one general rule over provider-, court-, or filename-specific
   branches.
3. Require a change to fix a recurring failure class or a correctness/safety
   defect; do not add machinery for one cosmetic outlier.
4. Measure the full frozen corpus after each change and reject fixes that trade
   away another jurisdiction or document class.
5. Track dependencies, production lines changed, branches added, and runtime
   cost beside the accuracy delta. Favour deletion or consolidation when two
   rules overlap.
6. Escalate only the remaining diagnosed hard scopes to the r=1 model repair;
   do not make model repair compensate for a simple deterministic bug.

The deliverable is a ranked failure report, minimized regression fixtures, and
a Pareto table showing robustness gained per added branch, dependency, runtime,
and production line—not an open-ended collection of special cases.

### Profiles and arms

Benchmark:

1. Deterministic local profile.
2. Local profile plus `gpt-5.6-luna` at low effort.
3. Local profile plus `gpt-5.6-terra` at low effort.
4. Local profile plus `gpt-5.6-sol` at low effort.
5. Local profile plus `gpt-5.6-luna` at xhigh effort as the control.

Use one frozen 80-page representative manifest while iterating, followed by a
complete 661-page confirmation run. Keep prompt, response schema, retry policy,
and evaluator identical between model arms.

### Measures

- Character and word error rates.
- Pairwise order, adjacent-order recall, and exact-position accuracy.
- Region boundary/type accuracy.
- Line coverage and immutable-text conservation.
- Footnote reference/body precision, recall, and F1.
- Proposition-pair correctness.
- DOCX-grounded paragraph, footnote, proposition, and citation recovery for
  each export profile.
- Schema-valid repair rate and failures after retry.
- Peak resident memory and wall time.
- Model-call count, latency, tokens, and estimated cost.
- Downstream output equivalence for each application adapter.

Measure weak-hardware behavior before setting a hard budget. The intended
default is sequential execution with practical sub-gigabyte memory use, but the
benchmark—not an assumed number—sets the supported hardware claim.

Choose defaults from the quality/cost/latency Pareto frontier. Codex repair must
demonstrate a downstream improvement over the deterministic baseline, not
merely produce more plausible-looking structure.

## Delivery Sequence

1. Freeze the JSON contract around existing Text-Fidelity canonical artifacts.
2. Wrap native extraction and footnote pairing in the local API and CLI.
3. Port ALR's materialization and proposition behavior behind that contract.
4. Run the deterministic benchmark and application-equivalence fixtures.
5. Add diagnostic-driven r=1 Codex repair and its cache.
6. Run all model arms and select a default from measured results.
7. Integrate Beaver first, then replace ALR's internal adapter, then add the
   TableOfAuthoritiesMaker PDF adapter.
8. Add an OCR adapter only when there is a concrete scanned-PDF corpus to test.

## Acceptance Criteria

- A digital-born legal PDF can be parsed locally without network access.
- Output is stable, versioned, inspectable JSON/JSONL.
- Repeated parsing of identical input is a cache hit.
- Footnotes with restarted numbers or symbols receive unique IDs.
- Exact footnote lookup does not parse or load the entire PDF again.
- The deterministic profile runs sequentially and does not retain all rendered
  pages in memory.
- Codex is called only for diagnosed hard scopes.
- A failed Codex repair cannot mutate source text or destroy a deterministic
  parse.
- Model and effort values are caller-configurable.
- Beaver, ALR, and TableOfAuthoritiesMaker can consume the same output without
  importing one another.
- Benchmark runs are reproducible from frozen manifests and fingerprints.

## Risks and Boundaries

- Broken font encodings can make embedded text unreliable even when it appears
  complete.
- Multi-column layouts, page-spanning notes, endnotes, numbering restarts, and
  symbol notes require identity beyond display labels.
- OCR creates a text-fidelity problem as well as a structural problem; it must
  not inherit native-text confidence.
- Model behavior, availability, and pricing can change. Version prompts,
  schemas, models, and caches explicitly.
- Confidential PDFs may not be eligible for remote model calls; the local mode
  remains fully usable and provenance makes model use auditable.
- Text-Fidelity-Project had no top-level license in the inspected checkout.
  Begin with adapters and clarify reuse/distribution terms before extracting
  its implementations into a separately distributed package.
- Do not add vector search, a daemon, or a plugin protocol to the engine.
  Consumer applications can layer those capabilities over the stable document
  contract if they actually need them.

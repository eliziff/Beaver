# Legal-text determinism plan: three optimizations from the LAB pilot autopsy

Date: 2026-07-28
Status: approved to build (this session). Written once before implementation;
results land in commit messages and the LAB protocol, not by editing this file.

## Motivation

The Harvey LAB pilot (benchmarks/lab/PROTOCOL.md; three tasks graded both
arms) produced a criterion-level failure taxonomy:

- **Dropped anchors** (~24 of Beaver's 39 misses): analysis present, specific
  fact absent — names, dates ("March 15, 2027"), figures ("$218.75M"),
  durations ("5 Business Days"), named tests. The model captured the gist and
  lost the enumerables.
- **Record fidelity** (both arms): computed figures (3.68x) presented while
  the certificate's stated figure (3.15x) went unreported.
- **Genre misread** (Arm A task 02, 22 criteria): a clean draft delivered
  where a flagged markup was required.
- **Enumerable-inventory gaps** (both arms): grace periods across Section
  8.01's subsections — items a complete structural enumeration cannot miss.

A zero-LLM probe (regex classes: money/percent/ratio-x/date/duration) over
task-03's sources vs Beaver's memo flagged 4 of the 13 misses outright
(March 15 2027 ×2 criteria, $218.75M, 5 Business Days) and, run in reverse,
flagged the whole record-fidelity cluster (3.68x/3.74x/1.24x present in memo,
absent from sources). Noise level: 192 source-only anchors — a triage report
for the model, not an auto-fail gate.

The premise: legal text is uniquely structured prose — numbered hierarchies,
defined-term symbol tables, canonical numeric/date/citation formats, and
words-and-numerals redundancy ("thirty (30) days") — so verification and
formatting work that generic harnesses leave to the LLM can be deterministic
here.

## Component 1 — Anchor extraction and two-way coverage diff

New `backend/src/lib/legalTextAnchors.ts`:

- Anchor classes: `money`, `percent`, `ratio` (x-multiples), `date`
  (textual + numeric forms), `duration` (N business days/days/months/years/
  quarters), `statute` (U.S.C./C.F.R./Del. C./§-style cites).
- **Canonicalization, not string matching**: "$2.25 million" ≡ "$2,250,000"
  (both → value 2250000); "March 15, 2027" ≡ "3/15/2027" (→ 2027-03-15);
  singular/plural durations unify. This is the upgrade over the probe, which
  missed exactly the $2.25M/$2,250,000 equivalence at issue in pilot-b-01
  C-060.
- **Words-and-numerals checksum**: parse "thirty (30) days" pairs; report
  mismatches ("thirty (20) days") as drafting defects. Deterministic,
  legal-text-only free lunch.
- Two-way diff with provenance: source-only anchors (omission candidates,
  each with filename + ±60-char context) and draft-only anchors (grounding
  candidates — figures the draft asserts that no source contains).

Surfaces:

- Tool `library_anchor_coverage` (LOCAL_LIBRARY_TOOLS): inputs
  `draft_document_id`, `source_document_ids[]`; bounded envelope output
  (per-class row caps, truncation flags). The model triages relevance; the
  arithmetic of presence/absence is never the model's job.
- Retro script `backend/scripts/anchor-coverage-retro.ts` (tsx, path-based,
  reuses `textParserFor`): run against pilot-b-03 and pilot-b-01 artifacts to
  measure how many judged misses the report would have flagged pre-submission.

## Component 2 — Skeleton-first context (the context/tool-suite change)

Premise: a credit agreement is a program. Definitions are a symbol table,
"Section 8.01(f)" references are calls, schedules are data segments, and the
numbering hierarchy is a native addressing scheme that makes chunk boundaries
deterministic. Legal documents are the only prose genre that ships its own
AST; Beaver should parse it once and navigate, not re-read 300k characters.

New `backend/src/lib/legalTextSkeleton.ts`, a plain-text structural parser
over `extractLocalDocument` output (works for DOCX, PDF, TXT, MD alike):

- Heading detectors: `ARTICLE <roman|number>`, `Section N.NN`, decimal
  ladders, `(a)/(i)/(A)/(1)` enumeration ladders with the standard
  (h)→(i) letter-vs-roman disambiguation.
- Node records: label, heading text, depth, char offsets (start/end of the
  section's span, exclusive of deeper siblings).
- Defined-terms index: `"Term" means|shall mean|has the meaning` plus
  parenthetical `(the "Term")` inline definitions → term → defining section.
- Cross-reference edges: `Section X.YY(...)`/`Article N` mentions mapped
  from containing node to target label.
- Schedule/Exhibit inventory.

Surfaces:

- Tool `library_outline`: bounded skeleton summary — numbered tree with
  headings, defined-term list (capped, with defining section), schedules,
  cross-reference counts. 1–3k tokens for a 100-page agreement; the complete
  map the model cannot fail to see. "Extract every grace period in Article
  VIII" becomes fill-in-the-enumerated-list, not hope-the-context-surfaces-it.
- `library_read` gains optional `section`: return only that node's span
  (plus children), with parent-chain breadcrumbs. Replaces
  300k-char pulls with pinpoint reads; composes with the announce-don't-
  preload manifest change (chat.ts 2d59ad0).

Relationship to existing planes: `library_lookup` remains the exact plane
for parsed PDFs; `docxStructuralLint` remains the authoring-side OOXML QA.
The skeleton is the reading-side navigation layer over any extracted text.
No persistent cache yet — the parse is regex-fast and `extractLocalDocument`
already caches extraction; persist per the document-intelligence layout only
if measurement shows it matters.

## Component 3 — Annotated tracked changes (genre by construction)

Arm A's task-02 zero came from delivering a clean draft where a markup was
required. Beaver already has the right organ: `library_revise_docx` →
`applyTrackedEdits` produces true w:ins/w:del revisions, and `EditInput`
already carries `reason` — but reasons die in the receipt; the document
shows naked edits. LAB-style markup criteria ("flagged provisions include
explanations") require the rationale IN the deliverable.

Extend `backend/src/lib/docxTrackedChanges.ts`:

- `annotate` option: each applied edit's `reason` becomes a real anchored
  Word comment (comments part created/extended, content-types + rels
  registered, `commentRangeStart/End` + `commentReference` spanning the
  revision). Existing comments preserved; IDs continue from max.
- Genre by construction comes from the PATH, not from policing: a markup
  produced through the revise pipeline is tracked changes by definition — a
  clean draft cannot come out of it. Whether every edit should also carry a
  rationale is measured, not mandated: unreasoned edits apply without a
  comment and the receipt counts them (`edits_without_reason`), so
  rationale-coverage becomes an A/B variable on markup tasks.
- Word comments are EMPHATICALLY opt-in (default off): they make Word
  laggy on long documents, and edit reasons already reach the user through
  the tracked-edit receipt card. `annotate: true` only on an explicit user
  request for in-document comments; plain tracked changes are the normal
  deliverable.
- `library_revise_docx` gains the `annotate` parameter, and its receipt
  auto-runs `lintLocalDocxStructure` on the new version, returning findings
  (broken xrefs, numbering gaps, defined-term defects) so the model gets
  deterministic feedback in the same turn.

## Measurement (after build; zero model calls)

1. Retro anchor coverage on pilot-b-03 (expect ≥4/13 misses flagged, plus
   reverse-grounding hits on 3.68x/3.74x/1.24x) and pilot-b-01 (count of 24
   misses flagged; person-name misses like "Thomas Brandt" are out of scope
   for regex classes and scored honestly as such).
2. Skeleton over `credit-agreement.docx`: verify Section 8.01 enumerates its
   subsections; defined-terms index resolves; `library_read section="8.01"`
   returns the correct span. Second corpus doc for numbering-style variety.
3. Annotated redline: compose sample edits with reasons, verify via
   python-docx/raw OOXML that w:ins/w:del counts match, comments part exists,
   comment anchors span the revisions, and existing-comment documents are
   not corrupted.

## Non-goals

- No embeddings/vector work (pinpoint-retrieval doc's asymmetric gate stands).
- No auto-injection of skeletons into the attachment manifest yet —
  announce-then-pull stands; the model pulls `library_outline` when needed.
- No LLM anywhere inside these components.
- No new store: skeletons are computed on demand; anchors are stateless.

## Relationship to the SLA proposal

These are the deterministic organs of Spec→Ledger→Draft→Audit→Grounding:
Component 1 is Ledger+Grounding for enumerable anchors, Component 2 is the
context layer that makes Draft small and Audit's re-reads pinpoint, and
Component 3 is the deliverable envelope that makes genre a build-time
property. The LLM keeps judgment; it loses bookkeeping.

## Mid-build addendum (2026-07-28 — the one permitted update)

**Reuse map, as discovered (adapt-don't-rewrite):** Component 2 compiles
into the existing `SourceDoc` plane (labels speak the A2AJ compiler dialect,
`sec8.01(a)`; lookup/slice/quote machinery unchanged). Defined-term
collection, `romanToInt`, and the external-reference guard are
`docxStructuralLint`'s own collectors, now exported. `evalValidators.
checkDocxStructure` is the redline verifier (no new python probes).
`benchmarks/beaver_can` (CAN-CITE/RETRIEVAL/CONTEXT dev tasks) is the other
session's live work — untouched; the Canadian slices below should feed it
later. ALR-Quote-Verifier (public build) is the grounding-gate reference:
clean-text↔raw offset index maps, editorial-initial span tolerance
("[T]he"), sentence-bound context windows, verified text-fragment
directives. Its ToA/Books-of-Authorities adaptations own citation-unit
splitting; the anchor `cite` class shares conventions via test vectors, not
imports.

**Text-Fidelity transfer:** the enumeration resolver is a faithful TS port
of `parse_heading_ladder`'s counter-stack (strict increment across all
readings → open at value 1 → restart/jump-forward → mid-counter open →
violation), so (h)→(i) disambiguation emerges from pass order; restarts get
`@n` occurrence suffixes; diagnostics are exposed on the skeleton.
Cross-engine sharing with the universal-legal-pdf-engine is by CONTRACT,
not code: one label dialect, one action taxonomy, shared JSON test vectors.
Page furniture, page-number witnesses, separator bands, and table geometry
remain the extraction layer's job — the skeleton consumes clean text.

**Grammar deltas beyond the original spec (each evidence-driven):** `cite`
anchor class (Canadian neutral + US reporter forms); Canadian statute
series (R.S.C./S.O./C.C.S.M. …) and `SOR/SI` instruments (the inventory's
headline silent-failure gap); currency-tagged money (`$` is
jurisdiction-neutral `dlr`) with attached suffixes ($20.0M/$2.25MM/$500K)
and comma/magnitude-guarded range inheritance; named-Code references
(Criminal Code); §-section trailing-dot normalization.

**Generalization assets (three subagent deliverables, all outside the
repo at `Desktop/legal-generalization-corpus/`):** (1) 31-document,
11-genre EDGAR/eCFR/Justice-Laws/court corpus with measured structure
notes — key traps: 1990s instruments with NO article tier, word-form
articles ("Article One"), Canadian "5 (1)" section form, ¶-numbered
complaints, `<ol>`-materialized numbering; (2) CUAD v1 (13,823 byte-exact
spans; typed-containment recall for date/duration/money anchors), MAUD
(business- vs calendar-day discipline), US public-law USLM XML (8,870
`@identifier` nodes — structure gold; 5,105 resolved citation refs); (3)
Canadian slices: A2AJ native-structure gold (2,848 statute labels, 8 NSCA
decisions with validated paragraph spines; four encoded traps incl.
map-order ≠ doc-order), 60-form anchor inventory, per-artifact rights
registry (NSCA is the open decisions source; Canadian Semantic LegalBench
still license-less → blocked; no CanLII scraping).

**Measurement battery (supersedes the original section):** retro anchor
coverage on pilot-b-01/-03 (done — see commit 9367619 for numbers); CUAD
typed-containment recall; USLM identifier-chain node P/R with enumerator
normalization; Canadian structure gold scored on `labels_doc_order` and
decision `labels_spine` (quoted-judgment ¶s are false positives); full
corpus structural sweep producing a measured fix-list; OCR-degradation
curve (seeded character-confusion injector over gold docs, label recall vs
corruption rate) — structure salvage on the hardest inputs is the proofing
ground. Rule of engagement: no grammar change without a corpus/gold
measurement that motivates it, and each fix cites its evidence.

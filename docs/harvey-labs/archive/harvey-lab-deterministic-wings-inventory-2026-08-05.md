# Deterministic wings — build-state inventory (2026-08-05)

Date: 2026-08-05 · Scope: every non-model, harness-side "deterministic wing"
that could be attached selectively to a harvey-labs benchmark arm · Method:
pure code + doc audit. **Zero model calls, zero network, read-only on the
repo.** Nothing under `benchmarks/harvey-labs/results/` was touched.

Purpose: let the selective-deployment study be designed on facts, not memory.
For each wing: does it EXIST as built code or only as DESIGN text; where
exactly; what it consumes/produces; whether any benchmark arm runs it today;
what concretely remains to make it arm-attachable; and what has actually been
measured about it.

**Reading note on the current chassis.** The winning chassis is whole-read +
the prompt completeness floor. Its four arms are registered in
`backend/scripts/lab-beaver-arm.ts` (`armEnvironment`, ~lines 695–738):
`mike_markdown_e2e_v1`, `mike_markdown_e2e_index_v1`,
`mike_markdown_e2e_floor_v1`, `mike_markdown_e2e_index_floor_v1`. **None of
them enables any audit organ.** The arm-env default block (~line 1000) sets
`MIKE_SLA_WORKFLOW: "0"`, `MIKE_GREENFIELD_REVIEW: "0"`,
`MIKE_GROUNDED_OUTLINE_INJECTION: "0"`, and none of the four override it. This
single fact drives most of the "BUILT-unwired" verdicts below.

**Reading note on the tool surface.** All four chassis arms carry exactly five
tools — `read_document`, `find_in_document`, `list_documents`,
`fetch_documents`, `generate_docx` (`UPSTREAM_MIKE_RETRIEVAL_TOOLS` plus one
`generate_docx` variant, in
`backend/src/lib/chat/upstreamMikeBenchmarkSurface.ts`; the index arm swaps two
schemas **in place** to preserve upstream tool order). **No `library_*`
deterministic organ is callable on any chassis arm.** So "wired into an arm"
below never means "the model can call it" — it means the harness runs it.

**Second pass (2026-08-05, later).** Wings 1–10 and §11–§13 are the first pass.
This pass added **wing 10b** (the defined-term resolver, which was materially
under-reported), corrected two first-pass errors about it (§12.9), and upgraded
the SLA deploy blocker from one gate to two after reading the chassis isolation
predicate (§1, §11C). Line numbers in `lab-beaver-arm.ts`,
`localAssistantTools.ts`, `upstreamMikeBenchmarkSurface.ts`,
`routes/chat.ts` and `upstreamNativeDocxRenderer.ts` were shifting under
concurrent edits during both passes — **cite the content anchors named here, not
the line numbers.**

---

## 0. Summary table

| # | Wing | Status | Flag / entry point | Deploy gap (one line) |
|---|---|---|---|---|
| 1 | SLA workflow + greenfield review revision pass | **BUILT-unwired** (wired only on legacy hybrid arms) | `MIKE_SLA_WORKFLOW=1`, `MIKE_SLA_STRATEGY`, `MIKE_GREENFIELD_REVIEW=1`; `backend/src/lib/chat/slaWorkflow.ts`; orchestration `backend/src/routes/chat.ts` ~3053–3203 | Register a chassis arm with the flag on **and** clear TWO hard gates in `lab-beaver-arm.ts`: the prompt-sha check (must account for the appended `slaLedger.promptSection`) and the isolation predicate, which asserts `surface?.sla_workflow !== false` → throw. |
| 2 | H1 derived-value + H2 deadline audit organs | **BUILT-unwired** | Same `MIKE_SLA_WORKFLOW=1` gate; `backend/src/lib/legalDerivedValueScan.ts` (`derivedValueScan`), `backend/src/lib/legalDeadlineOmissionScan.ts` (`deadlineOmissionScan`) | No independent flag — they can only be turned on by turning the whole SLA stack on. Same conformance-gate blocker as #1. Measured "ready for live A/B"; never run as a judged arm. |
| 3 | Absence-loop + coverage-assertion mechanisms | **DESIGN-only, and the design text is NOT in the repo** | — | Only a one-line disposition survives (`docs/harvey-labs/archive/harvey-lab-index-arm-ideas-ledger-2026-08-05.md` §10 "Cut"). The mechanism text was never written to any tracked file. Would be built from scratch. |
| 4 | Exposure / receipt machinery | **PARTIAL** — per-span data is *persisted*, only an aggregate ratio is *emitted* | `exposureMetrics()` in `backend/scripts/lab-beaver-arm.ts` ~374–453; `backend/src/lib/chat/evidenceExposure.ts`; receipts `beaver-receipts.json` | Per-document merged span map is computed then **discarded** (local `byDocument`). Emitting it + the unread complement is a small, contained change; the denominator (`source_receipts[].served_body_chars`) already ships. |
| 5 | Cross-reference graph machinery | **BUILT (kernel) / ABSENT (centrality, risky-term)** | `backend/src/lib/legalCrossReference.ts` (`crossReferenceGraph`), `referenceHubs` in `legalDocumentNavigator.ts`; arm `grounded_structure_outline_v1` via `MIKE_GROUNDED_OUTLINE_INJECTION=1` | Graph + in-degree hubs are shipped and wired to one legacy arm. Network centrality (PageRank/HITS) and the risky-term detector are doc text only; the §6.1 feasibility audit **never landed as a doc**. |
| 6 | `find_in_document` + SECT-INDEX | **BUILT-wired (split)**: find = arm-independent utility; SECT-INDEX = deliberately welded to one arm | `findTextMatches` in `backend/src/lib/chat/tools/documentOps.ts`; `backend/src/lib/chat/structureIndexExperiment.ts` behind `MIKE_STRUCTURE_INDEX=1` (+ `MIKE_READ_DOCX_MARKDOWN=1`) | Find is already reusable (4 consumers, incl. CourtListener). SECT-INDEX is siloed by design with a documented removal recipe; making it a general wing means un-welding the 7 `STRUCTURE_INDEX_ENABLED` branches in `localAssistantTools.ts`. |
| 7 | markdown↔docx round-trip conformance suite | **BUILT, runnable on demand** | `backend/src/lib/__tests__/docxCapabilityConformance.test.ts` (20 tests); `npx vitest run src/lib/__tests__/docxCapabilityConformance.test.ts` from `backend/` | None to run it. Gap: it does not cover `upstreamNativeDocxRenderer.ts`, a second markdown→docx path now being added. |
| 8 | Citation / quote-grounding machinery | **BUILT-wired on one legacy LAB arm** (Python-side); **BUILT-unwired** in TS; citation validation BUILT but off-LAB | LAB: `_linked_grounding` in `benchmarks/harvey-labs/harness/mike_workbench.py` (~468–548), arm `mike_one_shot_linked_grounding_xhigh_v1`. TS: `sourceDocPhraseSpans`/`sourceDocContainsQuote` (`sourceDoc.ts`), `quotationOccurs` (`evalValidators.ts`), `quoteRepairSuggestion` (`quoteRepair.ts`) | A working LAB checker already exists and has a measured result (120/298 quotes verified). It requires the model to *emit* structured grounding claims. A checker over a free-form deliverable still needs a quote/number harvester. |
| 9 | Redline / tracked-changes extraction | **BUILT-wired in product / BUILT-unwired on the LAB** | `projectDocxRedline` in `backend/src/lib/docx/redline.ts`, reachable in product via `read_document mode:"redline"` (`documentOps.ts`); experimental `extractDocxStories` in `backend/experiments/docx-analysis/stories.ts`; `scanDocxPathology` in `backend/src/lib/docx/pathology.ts` | Every LAB arm serves the **accepted view** (`extractDocxBodyText`), so struck text reads as operative — on a corpus with 200+ redline/markup documents. Deploying = swap the served plane + re-base offsets (markers change lengths). |
| 10 | Date / amount / party extraction utilities | **BUILT (dates, amounts, percents, durations) / ABSENT (party names)** | `extractAnchors` in `backend/src/lib/legalTextAnchors.ts` (~463); `anchorCoverage` (~888); `conflictScan`, `temporalScan` | Offsets + canonical value keys exist and are heavily tested. Missing: the N-way "same semantic slot, different value" clustering step, party/entity extraction, and named-date resolution ("the Closing Date" → ISO). |
| 10b | **Defined-term resolver + dependency listing** | **BUILT for 3 of 4 conventions; the dependency listing is BUILT AND ALREADY COMPUTED, then DROPPED** | `collectDefinedTerms` (`backend/src/lib/docxStructuralLint.ts`, 4 consumers); `DEFINITION_RE` + `INCORPORATION_RE`/`incorporatesDefinitions` + `importedUses` (`backend/src/lib/legalTermDrift.ts`); validation side = `undefinedTermScan` (`backend/src/lib/legalUndefinedTermScan.ts`); tool `library_term_drift` | Definition-section **headings** are the only undetected convention (raw material `SkeletonNode.heading` exists, nothing reads it). `termDriftReport(...).importedUses` — the cross-document "uses a term it does not define and does not import" listing — is computed inside `auditSlaDraft` and **thrown away**; surfacing it is a few lines. `definedTermSet()` (the merged extraction half) is **private**; export it or duplicate it. |

Status legend: **BUILT-wired** = code exists and some benchmark arm runs it ·
**BUILT-unwired** = code exists, no arm runs it · **PARTIAL** = the mechanism
exists but does not yet produce the artifact the study needs ·
**DESIGN-only** = doc/plan text, no code · **ABSENT** = neither.

---

## 1. SLA workflow / greenfield review revision pass

**Status: BUILT end-to-end. Unwired on the current chassis.**

### Where

- Module: `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\chat\slaWorkflow.ts` (936 lines).
  Content anchors: `slaWorkflowEnabled()` (~260), `buildSlaLedger()` (~281),
  `collectSlaDeliverable()` (~345), `auditSlaDraft()` (~549),
  `buildRepairPrompt()` (~504), `slaRevisionDrift()` (~876),
  `appendSlaReceipt()` (~922), `runGreenfieldStimulusReview()` (~147),
  `greenfieldReviewRepairPrompt()` (~206), `requestsOperativeDrafting()` (~237).
- Orchestration: `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\routes\chat.ts`.
  Ledger build + prompt append at ~1250–1256 (`if (slaWorkflowEnabled()) { … systemPrompt += slaLedger.promptSection; }`);
  the audit→revise→re-audit block at ~3053–3203.
- Tests: `backend\src\lib\chat\__tests__\slaWorkflow.test.ts`.
- Receipts: `MIKE_SLA_RECEIPT_PATH`, and `lab-beaver-arm.ts` **already** points
  it at `<labRoot>/results/<runId>/sla-receipts.jsonl` for *every* arm (~1025),
  with the comment *"inert unless the parent also sets MIKE_SLA_WORKFLOW=1"*.

### What the revision pass actually feeds back to the model

This was the specific question. Precisely three things, and nothing else:

1. **A capped, severity-ordered findings block.** `buildRepairPrompt()` assembles
   sections in fixed severity order (arithmetic > omission > definition >
   structural) under the header
   `"DETERMINISTIC CHECK (computed after synthesis; no model called it):"`,
   then hard-caps the whole thing at `MAX_REPAIR_PROMPT_CHARS = 2000`, dropping
   lowest-severity findings first and appending `…and N more findings (see receipt)`.
   Only each finding's `detail` string travels; the structured refs/excerpts
   stay in the machine receipt.
2. **A revision instruction** — either *"output the COMPLETE revised deliverable
   (full text, same format)"* or, when the deliverable is a library artifact,
   *"apply the corrections to the deliverable document itself with the library
   tools (revise the document; do not paste its content into chat)."*
3. **Optionally, the greenfield reviewer's findings** (`MIKE_GREENFIELD_REVIEW=1`)
   — a *second model call* (so this leg is not deterministic), given the request,
   the source documents (or the model-selected evidence union), and the
   candidate deliverable, returning ≤6 `{issue, source_document, source_excerpt,
   correction}` rows via the `submit_stimulus_review` tool, rendered into a
   `"INDEPENDENT STIMULUS REVIEW (fresh context; source-grounded findings only):"`
   block.

The revision is genuinely one-shot. `chat.ts` resets `visibleText`, resets
`contextEvidenceExposure = createEvidenceExposureState()`, emits
`{ type: "content_reset" }`, re-invokes `runProvider`, and then **re-audits**
(`revisedAudit`) purely to record drift — `slaRevisionDrift()` counts findings
that are NEW after the repair. No second repair is ever triggered. If the
revision produces nothing usable, the original draft is restored.

**Gating for the revision (`worthARevision`, ~707–727):** a pass is bought by
either ≥2 organs firing, or one high-precision organ (conflict / derived-value /
deadline), or temporal / term-drift / lint-errors / undefined-terms — with one
carve-out: `onlyH3SingleFinding` (exactly one organ fired and it was a single
undefined-term finding) does **not** buy a pass.

### Wired into any arm today?

`MIKE_SLA_WORKFLOW: "1"` appears in `lab-beaver-arm.ts` on
`coverage_finalist` (~549), `coverage_hybrid_v2` (~564), `checkpoint_paged_v1`
(~580), `coverage_soft_v2` (~621), `compiler_hybrid` (~634), `sla_hybrid` (~640),
`sla_working_set` (~647), `h9` (~654), `h10` (~662), `v5_reconstruction_v1` (~934).
**All of these are the older hybrid-retrieval family.** The four current-chassis
markdown arms do not set it, so they inherit the `"0"` default. `MIKE_GREENFIELD_REVIEW`
is `"0"` in the default block and is not overridden by **any** arm; every
preregistration JSON in `docs/` records `"greenfield_review": false`.

### Measured results

`docs/harvey-labs/results/hybrid-retrieval-v13-adversarial-audit-2026-08-02.md` ("SLA status",
~lines 171–186) is the disposition:

> "The SLA idea decomposes into two different things: 1. Deterministic checks and
> compiler receipts are valuable… 2. The SLA multi-stage orchestration has not
> earned its cost. H7's live cells used roughly 470k–2.15m tokens per task
> without a reliable accuracy win… v13 therefore sets `MIKE_SLA_WORKFLOW=0` but
> retains ordinary creation/edit receipts and deterministic checks invoked by
> those tools."

Note the asymmetry this creates: the audit condemned the *orchestration*, kept
the *checks* — but there is only one flag, so `MIKE_SLA_WORKFLOW=0` killed both.

### What remains to deploy it as an arm-attachable wing

1. **Audit-only mode already exists and is cheap.** Leaving `MIKE_SLA_STRATEGY`
   unset makes `buildSlaLedger` emit the short prompt section (the else-branch,
   ~319): *"Gated deterministic checks run after synthesis. If an actionable
   finding arrives, verify it against exact source spans and revise the actual
   artifact. The quality checks are automatic and are not model-callable tools."*
   That is ~200 characters of prompt delta — a controllable single-delta arm.
2. **The blocker is TWO conformance gates, both in the chassis-arm branch of
   `lab-beaver-arm.ts`.**
   - **(i) prompt-sha.** It computes
     `expectedPromptSha = sha256(expectedSurface.systemPrompt + inventoryPromptFor(documents, arm))`
     and throws `"<arm> served the wrong system prompt"` on mismatch. `chat.ts`
     computes the receipt sha over the *full* `systemPrompt`, which by then has
     `slaLedger.promptSection` appended. So **any SLA-on arm fails on the first
     tool round** unless `armExpectedSurface` is extended to append the same
     section.
   - **(ii) isolation.** The very next `if` throws `"<arm> isolation failed"` on a
     conjunction that includes, verbatim, `surface?.sla_workflow !== false` and
     `surface?.greenfield_review !== false` (alongside
     `markdown_swap_shape`, `markdown_e2e_shape`, `structure_index`,
     `completeness_floor`, `terminal_authoring`, resident-tool equality, and
     empty deferred/handoff/content-reset lists). Fixing the prompt hash alone is
     **not sufficient** — this predicate must be made arm-aware, the way
     `structureIndex` and `completenessFloor` already are (both are computed
     per-arm a few lines above).

   Both are real, mechanical blockers — not hypotheticals. Note also that
   `MIKE_SLA_WORKFLOW=1` silently *shrinks* the tool surface via
   `SLA_COMPILER_REPLACES` (`localAssistantTools.ts`): six `library_*` organs are
   filtered out because *"These organs become compile-time checks under the SLA
   workflow."* Inert on the current chassis (none is resident), but it collides
   with the resident-tool equality clause on any richer surface.
3. A new entry in `armEnvironment`, a new entry in `armExpectedSurface`, and a
   delta id (the pattern used by `MARKDOWN_E2E_INDEX_DELTA`).
4. Decide whether the greenfield leg is in or out. It is a model call, so it is
   not a *deterministic* wing; on flat-rate it is affordable but it makes the
   arm a two-delta arm.

---

## 2. H1 derived-value + H2 deadline audit organs

**Status: BUILT-unwired. Measured "ready for live A/B". Never run as a judged arm.**

Ledger `docs/harvey-labs/archive/harvey-lab-index-arm-ideas-ledger-2026-08-05.md` (Agreed next wave,
item 4): *"Then: H1/H2 deterministic omission audit as a live judged arm (built,
never run — the determinism branch of the goal)."*

### H1 — derived-value carry-through

- File: `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\legalDerivedValueScan.ts`.
  `derivedValueScan(sources, draft): DerivedValueOmission[]` (~214).
  Tuning: `MAX_FINDINGS = 12`, `VALUE_TOL = 0.02`, `PCT_TOL = 0.55`,
  `OF_REACH = 16`, `PART_REACH = 220`, `CROSS_DOC_BASE_REACH = 500`.
- **Consumes:** `DerivedValueDocument[]` sources + one draft — i.e. `{name, text}`
  plain text per named document. Not sections[], not markdown.
- **Produces:** `DerivedValueOmission { kind, direction: "percent_without_amount" |
  "amount_without_percent", base, detail, part, percent, whole }`, each ref being
  `DerivedValueRef { document, display, value, at, excerpt }` — **with char offsets**.
- **Runs on draft AND sources.** Identities are found in the source stack; the
  omission is decided against the draft. It cannot run source-only.
- Tests: `backend\src\lib\__tests__\legalDerivedValueScan.test.ts`.

### H2 — deadline working-back

- File: `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\legalDeadlineOmissionScan.ts`.
  `deadlineOmissionScan(sources, draft): DeadlineOmissionReport` (~393);
  `detectDeadlineRelationships(doc)` (~289) is the reusable **source-only** half.
- **Produces:** `DeadlineOmissionReport { findings, resolved, engaged, refusals }`
  with `DeadlineOmission { kind, engaged, trigger, detail, anchor, duration, resolved }`
  and typed `DeadlineRefusal { reason: "calendar_dependent" | "unstated_anchor" |
  "ambiguous_base" | "scan_capped", detail, count }`.
- Tests: `backend\src\lib\__tests__\legalDeadlineOmissionScan.test.ts`.

### H3 — undefined defined-term (the third organ; kept off)

`backend/src/lib/legalUndefinedTermScan.ts`. Runs under both work types in
`auditSlaDraft` but is measured as not corpus-ready. Ledger: *"H3 undefined-term
stays off (proper-noun floods)."*

### Both are gated by the same three things

1. `MIKE_SLA_WORKFLOW=1` (there is **no per-organ flag**).
2. A blind work-type gate: `derivedEligible = !requestsOperativeDrafting(...)`
   (~629) and `deadlineEligible = !requestsOperativeDrafting(...)` (~650) —
   both organs are **analytical-deliverable only**; operative drafting
   legitimately states a percent without an amount, or a period without a
   resolved date.
3. Caps `MAX_DERIVED_FINDINGS = 8` / `MAX_DEADLINE_FINDINGS = 8`, ordered by
   impact (`derivedAmount()` descending) and proximity (soonest `resolved` first).

### Measured results

**Module-header measurements (`legalDerivedValueScan.ts` ~16–42):**

> "Measure-first basis (2026-08-03, change-of-control stack, 19 sources + draft):
> 81 percent-of-base claims, 20 closed identities, 5 draft engagement omissions —
> each matching a failed gold criterion (C-008 $22.1M/25.3%, C-009 $23.9M/27.4%,
> C-010 $9.1M/10.4%); zero false positives on that stack."

> "measured: naive proximity pairing produced 132 false omissions on the
> change-of-control stack, closure pairing produced the 5 real ones"

**The generalization probe** (the "#6" probe) — script
`C:\Users\elias\Desktop\MikeOSS Fork\backend\scripts\dv-generalization-scan.ts`
(258 lines; `npx tsx scripts/dv-generalization-scan.ts` from `backend/`). Raw
outputs are in `.tmp/dv-gen-scan.txt`, `dv-gen-scan2.txt`, `dv-gen-scan3.txt`.
Phase 1 (source-side, whole vendored LAB corpus): *"tasks with >=1 claim or
closed identity: 156 (80 with >=1 closed)"*. Phase 2 canonical write-up, from
the module header:

> "Generalization probe (2026-08-03, whole vendored LAB corpus): the trigger
> pattern is not change-of-control-specific — 80 tasks across ~15 families state
> closed percent-of-base identities. But value-only draft engagement collides
> unrelated percents… The engagement gate therefore requires the draft's percent
> to be stated as 'of <base>' matching the identity's base; measured, that drops
> 8 cross-family false findings while preserving the 5 change-of-control ones."

**Corpus stress test** — `backend/scripts/deterministic-stress-test.ts` (zero
model calls) → `docs/harvey-labs/results/harvey-lab-deterministic-stress-test-2026-08-03.md`
(476 lines). 43 runs, 8 task families. Key numbers:

- Fire rates: derived fired on **20** runs, deadline on **22**, undefined on **43**.
- *"H1 (derived) fired on 20 runs; never at cap (0 at cap). Where it fires it
  names the source doc and the arithmetic. Counts are low (1–6), so the findings
  are dense and cheap to verify."*
- *"H2 (deadline) fired on 22 runs; never at cap (0 at cap). Its refusals dominate
  on source stacks without stated calendar anchors… which is the typed-refusal
  behavior the mechanism promises."*
- Detail-string self-containment: derived 124/142/171/187 chars (min/med/p90/max),
  deadline 158/191/209/213 — both name the source doc; H3 does not.
- Repair-prompt size across all 43 runs: min 1341, p50 3162, p90 4486, max 4829
  chars; **24 of 43 exceed the 3,000-char skimming bound**, H3 being the driver.

**Calibration against real failed gold criteria** (same doc, "Calibration
cross-check"):

- *"H2 deadline → C-018 (failed on all CoC arms)… The organ fired `written notice
  of non-renewal due 2026-01-14 − 180 days = 2025-07-18` on every CoC arm — the
  resolved date (2025-07-18 = July 18, 2025) is exactly the date the criterion
  requires."*
- *"H1 derived → C-008 (failed on all CoC arms)… it names the half that criterion
  penalizes as missing."*

**Readiness verdicts** (same doc): *"H1 (derived) — ready for live A/B on the
analytical families where it fires (CoC, tax, diligence, antitrust)."* ·
*"H2 (deadline) — ready for live A/B where it fires… Validate a sample of fired
`resolved` dates against gold before enabling repair, since a wrong resolved date
is worse than no finding."*

### ⚠ Honest caveat that must not be lost

**No precision/recall figures exist anywhere for H1 or H2.** The stress test's
own caveats say so explicitly:

> "Caveat: 43 of 43 scored runs here FAILED (0 passed), so this section is empty
> by construction — there is no passed draft to cross-reference."

> "Scores are fixed-Sol criterion labels, not human gold. A PASS is the judge's
> verdict, so 'false positive' here means 'fired on a judge-PASS run', not 'wrong
> per a lawyer'."

What exists is: fire counts, cap-rates, zero-FP-on-one-stack, and two
criterion-level calibration hits (C-008, C-018). "Zero false positives" is a
claim about the single change-of-control stack, not a corpus rate.

### Deploy gap

Identical to wing 1 — they have no flag of their own. Attaching H1/H2 to the
chassis means: (a) a new arm entry with `MIKE_SLA_WORKFLOW=1`, (b) **both**
conformance fixes — the `armExpectedSurface` prompt-sha extension *and* making
the isolation predicate's `surface?.sla_workflow !== false` clause arm-aware,
(c) accepting that the SLA ledger loads all
in-scope source texts host-side (bounded at `MAX_LEDGER_DOCUMENTS = 32`), and
(d) deciding whether to also carry H3 (recommended off) and the other four
organs in the same stack (anchor coverage, conflict, temporal, term-drift, lint).
If a "H1/H2 only" arm is wanted, that is a *new* selector inside `auditSlaDraft`
— currently the stack is all-or-nothing.

---

## 3. Absence-loop + coverage-assertion mechanisms

**Status: DESIGN-only — and the design text is not in this repository.**

### What I found, exhaustively

A repo-wide ripgrep for `absence.loop|coverage.assertion|assert-or-mark-absent`
(case-insensitive) returns **exactly one file**:
`C:\Users\elias\Desktop\MikeOSS Fork\docs\harvey-lab-index-arm-ideas-ledger-2026-08-05.md`.
Within it, two references and no mechanism text:

§10 "Cut (dropped / parked)":

> "**Absence-loop / coverage-assertion machinery** — designed then cut by user:
> not mostly an absence problem; per-section coverage checks are inefficient
> whole-reads."

> "**'Never-read section N' checker** — coverage-checking in disguise (user cut)."

The nearest surviving statement of the *idea* is §7, as the oracle's recommended
higher-leverage arm:

> "**Higher-leverage arm (synthesis side, recommended by the oracle):** a
> post-draft criteria-coverage self-audit — draft against the existing evidence
> manifest, then require the model to assert-or-mark-absent each deliverable
> requirement. C-026 (had both facts, didn't connect), C-057/058 (read the grace
> text, didn't extract), and the upstream collapse all point here. (This is the
> 'completeness self-check before drafting' already allowed as general discipline
> in the no-overfit doctrine — a mechanism, not a per-task checklist.)"

And §9 "Honest gaps":

> "**'Model never read section N' check does NOT exist.** Raw materials exist
> (`readState.deliveredChars`, SECT-INDEX label list, `evidenceExposure` ranges)
> but the diff is new work. *Note: Eli's earlier cut — coverage-checking is a
> whole-read in disguise — argues this stays unbuilt.*"

### ⚠ DOC-VS-CODE MISMATCH (flagged)

The tracker records task #28 as **completed** ("Design absence-loop +
coverage-assertion mechanisms"), but the design deliverable is not in the tree.
There is no plan file, no research-plan section, no `plans/` directory (the
ledger references `plans/iridescent-puzzling-church.md`; **no such file and no
`plans/` directory exist anywhere in the repo**). The design appears to have
lived only in an agent transcript. What survives is the *verdict*, not the
*mechanism*.

Practical consequence: if the selective-deployment study wants this wing, the
design must be re-derived. The good news is that its two hardest inputs are
already built (see wings 4 and 6): interval coverage arithmetic
(`mergeIntervals` / `coveredLength` / `readCoversBody`) and a per-document span
record in the receipts.

### What would need building

1. A **served-span → unread-span complement** per document (wing 4 gap).
2. A **claim → coverage-basis binding**: a negative assertion in the deliverable
   ("there is no inconsistency between §7.05 and §2.05(b)") must carry the span
   set it was decided over. Nothing in the repo relates deliverable sentences to
   exposure ranges today.
3. A **gate or a receipt**: either refuse the negative assertion when its basis
   spans are unread, or (cheaper, and consistent with the one-shot doctrine)
   just record it and let the judge/analysis see it.

The banking-index C-011 case (wing 4, below) is the empirical argument that this
wing is worth something: the model **asserted an absence** over a span it never read.

---

## 4. Exposure / receipt machinery

**Status: PARTIAL. The per-span data is persisted; only an aggregate ratio is emitted.**

This is the wing with the most important nuance, so it gets the most detail.

### What is built

**(a) Runtime exposure state** —
`C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\chat\evidenceExposure.ts`.

- `EvidenceExposureState { covered: Map<string, Range[]>, ranges: StoredRange[],
  refs: Map<string, StoredRef>, uniqueSourceChars, suppressedSourceChars, nextSequence }`.
- `StoredRange = { start, end, documentId, versionId, filename, locator?, projection,
  kind: "candidate" | "evidence", sequence }` — **this is already a per-document
  span record with provenance.**
- `applyEvidenceExposure()` (~344) is the accretive dedup: for each incoming
  evidence segment it computes `uncovered(segment, covered)` and merges. The
  coverage key is `${documentId}:${versionId}:${projection}:${kind}` — note that
  candidate previews and evidence reads keep **separate** unions by design, *"so
  a Grep hit never suppresses the later Read that proves it."*
- `mergeRange()` / `uncovered()` (~185, ~198) are exactly the interval algebra a
  coverage certificate needs — `uncovered()` literally returns the complement.
- Tests: `backend\src\lib\chat\__tests__\evidenceExposure.test.ts`.

**(b) Read-state interval coverage** —
`C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\chat\localAssistantTools.ts`,
exported at ~2131–2176: `mergeIntervals(intervals)`, `coveredLength(intervals,
start, end)`, `readCoversBody(read)`. These back the coverage-based `already_read`
refusal (~6030–6044), whose comment states the design intent:

> "A repeat read is suppressed only when prior reads COVER the full body span
> (interval union, not a char-count sum — overlapping windows used to trip this
> refusal while a real hole stayed unread)."

Per-turn `readState` entries carry `{ documentId, docLabel, versionId, filename,
deliveredChars, bodyStart, intervals }` (~6129–6145). Tests:
`backend\src\lib\chat\__tests__\bodyPlaneReads.test.ts`.

**(c) Benchmark-side aggregation** —
`C:\Users\elias\Desktop\MikeOSS Fork\backend\scripts\lab-beaver-arm.ts`,
`function exposureMetrics(calls, results, sourceAliases)` (~374–453).

**(d) Denominator** — `sourceReceipts` (~1962–1997) records per document:
`served_body_chars`, `document_id`, `version_id`, `text_chars`, `text_sha256`,
`pages`, `table_cells`, plus source/upload hashes. The comment names the
plane discipline explicitly:

> "The exposure numerator lives on the served BODY plane (pandoc markdown for
> markdown arms, SECT-INDEX excluded). The denominator must be the same plane per
> document — the plaintext denominator made the ratio cross-plane, and shipped
> runs reported impossible values > 1."

### The answer to the key question

**It can only emit an aggregate ratio today — but a per-document served-span map
is fully reconstructible from the shipped receipts.**

`exposureMetrics` *does* build the per-document span map. Line ~380:
`const byDocument = new Map<string, Array<[number, number]>>();` keyed
`${documentId}:${versionId}`. It fills it, sorts and merges each document's spans
(~427–439) — and then **returns only scalars**:

```
gross_source_span_chars, unique_source_span_chars, documents_exposed,
exposed_document_ids, gross_replay_ratio, gross_evidence_ref_chars,
unique_evidence_ref_chars, unique_evidence_refs
```

`byDocument` is a local variable and is discarded. `metrics.json` then derives
`unique_source_exposure_ratio = unique_source_span_chars / sourceTextChars`
(~3174–3179) — one number for the whole run.

**However**, `beaver-receipts.json` (written at ~3196–3234) persists
`tool_results` — and each result carries `evidence_segments` with
`{documentId, versionId, start, end, kind, projection, virtualPath}` — alongside
`source_receipts` with the per-document `served_body_chars` denominator. So every
input to a served-span map is on disk, per run, today.

**Proof that this reconstruction works:** it has already been done by hand.
`docs/harvey-labs/results/harvey-lab-phase-c-criteria-forensics-2026-08-05.md` §4 states its method
as *"exposure from `beaver-receipts.json` (`evidence_segments` +
`source_receipts.served_body_chars`)"* and prints an actual served-span map:

> "The index arm read `credit-agreement.docx` at only 38,066 / 145,997 chars
> (26.1 %), across 10 blocks:
> `[3908,4924] [6368,7584] [8246,9865] [18517,19733] [28109,30109] [40759,41959]
> [65005,70005] [75455,88455] [88454,97454] [107050,109850]`"

…and then attributed 7 specific criterion failures to named gaps
(`[19733, 28109]`, `[9865, 18517]`, `[30109, 40759]`).

### The measured case that motivates a coverage certificate

Same doc, §4 — this is the single strongest empirical argument in the repo for
this wing:

> "The C-011 failure mode is the one worth flagging to the experiment: the arm
> did not merely omit the conflict, it **asserted its absence**. Judge: *'The memo
> explicitly states there is NO inconsistency between Section 7.05's 365-day
> reinvestment period and Section 2.05(b), calling them "consistent."'* … It had
> read §7.05 (inside `[75455, 88455]`) but never §2.05(b), and then made a
> confident negative claim about the relationship between the two. **A retrieval
> window that covers one side of a cross-reference produces false negatives, not
> just silence.**"

Aggregate from the same doc's summary table: across 11 judged Phase C runs, of
106 total misses — **read-gap 2, exposure-gap 31, synthesis 30, depth 23,
judge-strict 20**. Exposure-gap is the single largest class, and every one of the
8 whole-read cells (`unique_source_exposure_ratio` = 1.000, plus capmkt
index_floor at 0.896) has **zero** read-gap and **zero** exposure-gap misses.

### Known defects in this machinery (from the triple audit, ledger §"TRIPLE AUDIT")

- **D4 (fixed by `76e54625`):** `unique_source_exposure_ratio` mixed planes
  (markdown numerator / plaintext denominator) — two shipped runs reported
  ratios > 1 (1.021, 1.017).
- **D5/D6 (fixed by `76e54625`):** `documents_read` counted zero-length exposures
  (CoC true coverage 9/19, reported 10/19). The zero-length guard is now at
  ~403–405: *"Zero-length segments deliver no source text and must not mark the
  document exposed (a (0,0) segment once counted a doc as 'read')."*
- **Still open:** `past_end_tool_calls` and `zero_yield_tool_calls` were reported
  as 0 by blind instrumentation.

### What a "coverage certificate" (unread-span report) would need

Small and contained — nearly all of it is a plumbing change, not new logic:

1. **Return `byDocument` from `exposureMetrics`** instead of discarding it (it is
   already merged and sorted). ~5 lines.
2. **Complement it** against `served_body_chars` per `{document_id, version_id}`
   to produce unread spans. The complement routine already exists twice:
   `uncovered()` in `evidenceExposure.ts` and `mergeIntervals`/`coveredLength`
   in `localAssistantTools.ts`. Reuse, do not re-derive.
3. **Label the unread spans.** This is the only genuinely new piece: an unread
   range `[19733, 28109]` is not actionable until it is named "§1.06–§2.05".
   The labeller already exists — `renderStructureIndex`'s spine plus the `@N`
   offsets (wing 6) map body offsets to section displays — but it is behind
   `MIKE_STRUCTURE_INDEX=1`, so a whole-read arm has no section labels today.
   `sectionResolver` (`legalConflictScan.ts` ~166, duplicated at
   `legalTemporalScan.ts` ~180) is the arm-independent alternative: offset →
   `"sec3.1"` via lazily compiled skeleton.
4. **Emit it** into `metrics.json` (or a sibling `coverage-certificate.json`)
   and, if the study wants a live gate, into the model context.

Note the standing objection recorded in the ledger, which the study should
answer explicitly rather than ignore: *"coverage-checking is a whole-read in
disguise (user cut)"*. A **post-hoc receipt** does not have that problem — it
costs zero model tokens. A **live gate** does.

---

## 5. Cross-reference graph machinery

**Status: BUILT (kernel + in-degree hubs) / ABSENT (network centrality, risky-term).**

### What exists as real code

- `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\legalCrossReference.ts` (707 lines):
  `crossReferenceGraph(text, id, opts)` (memoized via a `WeakMap` `graphCache`,
  real work in `crossReferenceGraphUncached`), `definedTermEdges(...)` (TERM
  layer, dormant), `lexicalOverlapEdges(...)` (LEXICAL layer, deliberately
  separable "so it can be measured and, if redundant, retired").
  Consts `DEFAULT_INTEGRITY_GATE = 0.5`, `MIN_ADDRESSABLE_NODES = 3`,
  `MIN_TARGET_REACH = 0.05`. Tests: `backend\src\lib\__tests__\legalCrossReference.test.ts`.
- `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\legalDocumentNavigator.ts`:
  `referenceHubs(graph, limit = 12)` (~553) — plain resolved-in-degree counting,
  skipping self-loops and unresolved edges. **This is the only "centrality-ish"
  thing built.**
- `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\legalProvisionGraph.ts` (578 lines):
  `extractProvisionGraph`, `compileProvisionGraph`, `renderProvisionGraphHtml`,
  `renderProvisionGraphSvg`. Tests: `backend\src\lib\__tests__\legalProvisionGraph.test.ts`.
- `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\legalReferenceGrammar.ts`:
  `findProvisionReferences`, `PROVISION_REF`, `FR_PROVISION_REF`,
  `isExternalReferenceInContext`.
- CLI: `backend/scripts/xref-census.ts`, `xref-diagnose.ts`,
  `xref-probe-spread.ts`, `xref-probe-terminator.ts`.

### Wiring

- Agent tool `library_links` — `localAssistantTools.ts` (registered ~358, handler
  ~8339), calls `documentGraph(...)` then `referenceHubs(graph)` (~8384), emitting
  `hubs: [{ section, referenced_by }]`. Abstains (`abstained: true`) rather than
  faking zero edges.
- LAB arm `grounded_structure_outline_v1` —
  `backend/src/lib/chat/labOutlineInjection.ts`
  (`buildLabOutlineInjectionBlock`, `topReferencedSections`,
  `GROUNDED_STRUCTURE_OUTLINE_INJECTION_ENABLED` ←`MIKE_GROUNDED_OUTLINE_INJECTION=1`,
  `LAB_OUTLINE_TOP_K = 8`, `LAB_OUTLINE_TOTAL_MAX_CHARS = 6_000`); injected in
  `routes/chat.ts` after the AVAILABLE DOCUMENTS block. **Not on the current
  chassis** — the default block sets the flag to `"0"`.

### What was only assessed (task #4)

The feasibility assessment lives as design text in
`docs/harvey-labs/design/harvey-lab-harness-features-plan-2026-08-03.md`, hypotheses H7/H8/H9 + §6.1:

- **H9 (centrality)** — *"The graph exists…; but centrality is only as good as the
  edges, and the header's own data shows weak edge density (31/227 maud fragments
  have any outgoing edge)… Risk: hubs name boilerplate (definitions article,
  governing law) rather than the operative clauses."* Mechanism *"Pending §6.1
  audit of edge quality. If clean: degree/HITS on literal+term edges."*
- **H8 (risky-term)** — *"Feasibility depends on the §6.1 audit… Unknown until
  audit; likely a sub-feature of H1/H3 rather than a standalone."*

**No PageRank/HITS/eigenvector/betweenness code exists anywhere in
`backend/src` or `backend/scripts`. No risky-term detector exists** (no
`riskIndex`, no "sole discretion" scanner).

### Measured results

Self-measurement in the `legalCrossReference.ts` header (zero model calls):

> "Resolver, over the 45 documents that pass the integrity gate: 2,428 resolved /
> 307 unresolved / 1,720 external / 4,779 refused of 9,234 references detected.
> 3.3% of accepted references miss — the graph is a trustworthy instrument on the
> documents it accepts. … only 31 of 227 maud gold fragments have any outgoing
> edge at all. The weak layers lose to contiguous context everywhere: defined-term
> 0.12-1.29%, lexical 0.81-4.57%. On THIS bed the graph is not a recall mechanism;
> if it earns arms it will be as structure shown to a composer, not as extra
> retrieved context."

The 2026-08-05 oracle went further and killed the salience role specifically
(ledger §7 cross-tab): cross-ref in-degree was **above the non-miss median for
only 20% of change-of-control misses** (marked "**negative**") and 33% on banking
— i.e. worse than chance as a miss predictor. Ledger §9: *"SUPERSEDED
(2026-08-05) for the salience role by the oracle… the per-line ref-count steer is
NOT worth wiring. The graph retains value as the (c) resolver and as a
completeness footer (unresolved-targets flag), but not as a read-side salience
annotation."*

### ⚠ DOC-VS-CODE MISMATCH (flagged)

`docs/harvey-labs/design/harvey-lab-harness-features-plan-2026-08-03.md` §6.1 is still written in
the present tense — *"A subagent is auditing… update this doc when it lands"* —
and **no such update and no separate xref-audit doc exists in `docs/`**. The
H7–H9 build order item ("only after the §6.1 audit lands") is therefore still
formally blocked on a deliverable that never landed, even though the substantive
verdict has since been rendered elsewhere (the oracle cross-tab in the ledger).
Anyone reading only the features plan would conclude centrality is "pending
audit"; anyone reading only the ledger would conclude it is "twice-negative,
killed". Both are in `docs/`.

### Deploy gap

- As a **resolver** (offset/label → related sections): ready today, arm-independent,
  importable.
- As a **read-side salience steer**: measured negative twice; the ledger's
  "Killed" list includes *"salience-ranked index (twice-negative)"*.
- As **centrality / risky-term**: new code, and the doc-declared prerequisite audit
  has no artifact.

### Stray probe artifacts (checked, so they are not mistaken for implementations)

`backend/.tmp-debug-xref.ts` is a throwaway driver over the shipped
`crossReferenceGraph`. `backend/.tmp-provision-graph-{1-merger,2-nda,3-employment}.html`
(790 KB etc.) and the matching `.svg` are **outputs** of the shipped
`renderProvisionGraphHtml`/`Svg`, generated by `backend/.tmp-gen-3.ts` over three
hand-written synthetic contracts. None of these is a parallel implementation.

---

## 6. `find_in_document` + SECT-INDEX

**Status: `find_in_document` = BUILT, arm-independent, wired. SECT-INDEX = BUILT, wired, deliberately welded to one arm.**

### `find_in_document`

- Core matcher: `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\chat\tools\documentOps.ts` —
  `findTextMatches({ text, query, maxResults, contextChars, startIndex? })` (~1360),
  with `normalizeWithMap(text)` (~1326) and `normalizeQuery(q)` (~1347).
  Sibling `findRegexMatches` (~1411) is the grep-mode variant.
- **Matching is whitespace-tolerant and case-insensitive**, implemented as a
  run-collapsing normalizer with an index back-map (not a lossy regex): every
  whitespace run becomes one space, everything else lowercases, and `origIdx`
  maps each normalized position back to the original. Search is
  `norm.indexOf(needle, from)` — literal substring, deterministic, no regex.
  `normalizeQuery` is `q.trim().replace(/\s+/g, " ").toLowerCase()`.
- **Offsets:** `TextMatch.at` is an *original-text* offset — documented as
  *"composable with windowed reads and structural lookup, like grep's file:line"*.
  The tool result adds `locator: chars ${start}-${end}`.
- **Arm-independent: yes, demonstrably.** Four consumers, including
  `backend\src\lib\chat\courtlistenerToolRunner.ts` (~422) — an entirely
  different domain (US case-law search). Also `findInDocumentContent(...)`
  (~1461) → `toolDispatcher.ts` (~485) for production chat.
- **A second, independent implementation exists in the Python harness:**
  `benchmarks\harvey-labs\harness\mike_workbench.py`, `_find_in_document` (~426),
  which is also whitespace-tolerant but via
  `re.sub(r"(?:\\\s)+", r"\\s+", re.escape(query))`. It has **no** SECT-INDEX
  awareness. The two have diverged.

### SECT-INDEX

- `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\chat\structureIndexExperiment.ts`
  (347 lines, self-labelled "SILO'D LAB EXPERIMENT").
  Emitter: `renderStructureIndex(nodes, markdown?)`. Banner and line template:

  > `SECT-INDEX (derived from the document's own numbering; ${spine.length} numbered sections/parts; @N = offset into the body below this index — read only what the deliverable requires)`
  >
  > `  Section 2.01(a) — Subject to the terms and conditions set forth her…  @39811`

- `@N` is a character offset into the **served markdown BODY** — offset 0 is the
  first body char below the index block. `anchorSpine` computes offsets against
  the raw pandoc markdown *before* prepending, so the values are body-relative
  by construction; `attachStructureIndex(markdown, index)` returns
  `` `${index}\n\n${markdown}` ``.
- Other exports: `deriveSectionNodes(bytes)` (consumes the existing detectors
  `extractDocxBodyStructure` + `compileAgreementSkeleton` — **no detector was
  modified**), `indexIsAddressable(served, bodyOffset)`,
  `INDEX_MIN_ANCHORED_LINES = 5`, `INDEX_MIN_ANCHORED_FRACTION = 0.25`.
- **Welded, by design.** One consumer file (`localAssistantTools.ts`, seven
  `STRUCTURE_INDEX_ENABLED` branches: tool-schema selection ~1949,
  `servedDraftingText` ~5880, scoped-arg parsing ~6246, scoped-only refusal
  ~6278, per-doc fetch refusals ~6466/~6497, and the find-plane switch ~6615),
  plus the arm registry and the prompt constants. The module header gives the
  exact removal recipe.

### The plane guarantee

Single point of truth: `servedDraftingText(userId, documentId, cache?)` in
`localAssistantTools.ts` (~5865) returning `{ served, bodyOffset, versionId,
filename }`, with `bodyOffset = served.length - source.markdown.length`.

The commit-title behaviour ("find shares the markdown plane") is the find branch
(~6612–6628): under `STRUCTURE_INDEX_ENABLED`, find searches
`drafting.served.slice(drafting.bodyOffset)` — the body only — so a hit's `at`
is in the same coordinate space as an `@N`. Reads re-add the base (~6108); F3
moved evidence spans onto the same body plane (~6138), *"so the harness can
union read + find coverage in one coordinate space."*

**Three caveats on the guarantee, all material to a coverage study:**

1. It is conditional on `STRUCTURE_INDEX_ENABLED`. On `mike_markdown_e2e_v1` /
   `mike_markdown_swap_v1`, `read_document` serves **pandoc markdown** while
   `find_in_document` serves **`extractLocalDocument` plaintext** — a known,
   intentional plane mismatch preserved to keep those arms byte-identical to
   their published baselines.
2. `head`/`tail`/`index=true` are handled separately (~6083–6106) because slicing
   the served plane once delivered 100% index and 0% body (*"a head:120 fetch once
   returned 10,723 index chars and zero body chars"*).
3. `servedDraftingText` catches index-derivation failures and silently returns
   `{ served: source.markdown, bodyOffset: 0 }`, so documents can fall back to an
   index-free plane **heterogeneously within one run**.

### Flags

`MIKE_STRUCTURE_INDEX` (default off) is the master gate; `MIKE_READ_DOCX_MARKDOWN`
(default off) must also be `1` or `servedDraftingText` returns `null` and the
index is inert. Related: `MIKE_TOOL_SHAPE`, `MIKE_COMPLETENESS_FLOOR`,
`MIKE_SUPPRESS_DUPLICATE_WHOLE_READS` (note inverted polarity: `!== "0"`, so
default **on**).

### Measured results (from the ledger)

- Corrected index arm vs whole-read control, change-of-control: **47/57 vs 49/57**,
  10/19 vs 18/19 docs read, 17.2% vs ~full exposure, 24 vs 52 tool calls,
  210s vs 394s.
- Anchoring rates on real corpora (triple audit D7): *"HSR 4/5 docs at **0%**;
  EMP playbook 0%, redline 7%; CoC webb 2%, terraverde 3%, pinnacle-license 15%,
  both memos 0%. The 95% figure came from the single covenants tuning fixture."*
  `indexIsAddressable` (A2) exists specifically to stop gating reads on documents
  with no usable addresses.
- Audit fixes F1–F7 landed in `f1150a9d`; F2/F6/F7 were three distinct anchoring
  bugs (covenants docx: 5/174 bad subsection anchors → 0). **`f1150a9d` added no
  new tests** despite that.

### Coverage gap worth knowing

No test exercises the find-plane swap end to end — nothing asserts that a
`find_in_document` hit offset resolves to the same text when fed back into
`read_document offset=`. The plane-consistency claim is verified by construction
and by untracked `.tmp-*.ts` probes only.

Also: `findTextMatches`'s normalizer collapses whitespace and lowercases but does
**not** strip pandoc decoration (`**`, `\(`, `<u>`). `structureIndexExperiment.ts`
has `stripLineDecor` for exactly that problem and does not share it with find —
so on the index arm, a model quoting a clean phrase from a SECT-INDEX heading tail
can fail to find it in a body where pandoc injected bold markers mid-phrase.

---

## 7. markdown ↔ docx round-trip conformance suite

**Status: BUILT and runnable on demand.**

- Suite: `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\__tests__\docxCapabilityConformance.test.ts`
  — 537 lines, **20 `it()` tests**, 9 `describe` blocks: tables (merged/nested),
  auto-numbering, tracked changes, headers and footers, footnotes, text boxes,
  real document ingestion, real-world corruption fixtures, and
  *"round trip: rendered Markdown re-ingests without losing substance"*.
- **Command** (from `backend/`):
  `npx vitest run src/lib/__tests__/docxCapabilityConformance.test.ts`.
  There is no dedicated npm script (`backend/package.json` has only
  `"test": "vitest run"`).
- **What it verifies.** Both directions, through the *real* production functions:
  ingestion via `extractDocxDraftingSource` (pandoc-gfm `pandoc-markdown-v1`),
  `extractDocxBodyText`, `resolveDocxNumbering`/`applyNumberingToText`,
  `projectDocxRedline`, `extractDocxStories`; output via `parseDocxMarkdown` /
  `renderDocxMarkdown` / `renderDocxMarkdownDocument` / `renderMarkdownDocx`,
  with the produced package opened with JSZip and asserted at OOXML level
  (`<w:tbl>`, `<w:numPr>`, `<w:lvlText w:val="%1.%2"/>`, `<w:footnoteReference>`,
  `<w:tag w:val="…"/>`), including **negative** assertions
  (`not.toMatch(/<w:gridSpan/)`, `settings.xml` never `w:trackChanges`).
- **Core invariant:** a feature class either survives the wire **or** is a
  *documented drop* — and the drop is asserted too, by pinning the exact warning
  string and `requires_review`. Silent loss fails the suite in either direction.
  The base round-trip must be warning-free: `expect(source.warnings).toEqual([])`
  and `expect(source.requires_review).toBe(false)`.
- Fixtures: in-memory `buildPathologyFixtures()`
  (`backend/src/lib/__tests__/fixtures/docx-pathologies/generate.ts`), one real
  regulation (`benchmarks/docx_edit/fixtures/real/ferry-boats-remission.txt`),
  and three committed corruption fixtures (`corrupt-style.docx`, `truncated.docx`,
  `malformed-body.docx`) pinning the fail-closed degradation contract.

### Recorded results

`docs/harvey-labs/results/docx-capability-conformance-2026-08-03.md`:

- *"Round-trip finding: render → ingest → render is clean (post-Pandoc migration)"*
  — warning-free for the base round-trip.
- *"Out of the six scored classes: a content control `{{tag}}` does not survive a
  round-trip as a control — it renders as its placeholder text (`[Tag]`) and
  re-ingests as that text, losing the tag."*
- Documented drops: merged/nested table authoring (`gridSpan`/`vMerge`),
  **tracked changes (markdown is accepted-view only, flattened with no warning** —
  named as the blind spot the bench's `redline-already-deleted` /
  `redline-struck-carveout` tasks measure), custom headers/footers,
  multi-paragraph footnote bodies, non-decimal/letter/roman numbering.
- Flagged asymmetry: **text boxes** — mammoth carries `w:txbxContent` into the
  drafting view (readable, no warning) but `extractDocxBodyText` drops it, so
  there is *no body-plane anchor to edit it*.

### Deploy gap

None to run it. One real coverage gap: the suite tests `renderDocxMarkdown` /
`extractDocxDraftingSource` only, and **does not cover
`backend/src/lib/chat/upstreamNativeDocxRenderer.ts`** — a second markdown→docx
path currently being added. If that becomes a live rendering path, the suite
should be extended or the conformance claim narrows.

---

## 8. Citation / quote-grounding machinery

**Status: a quote-grounding checker is BUILT *and already wired into one LAB arm* (Python-side, with a measured result). Four more, richer checkers exist TS-side, unwired. Legal-citation validation is a separate, larger stack, off-LAB.**

The distinction that matters here is **intra-document verbatim quote verification**
("does string X appear in document Y, tolerantly") versus **citation-format
validation** ("is this a well-formed, resolvable case cite"). Both exist; they are
different code with no shared path:

| Question | Module | Nature |
|---|---|---|
| "Does string X appear in doc Y?" | `sourceDoc.ts`, `evalValidators.ts`, `mike_workbench.py` | token/whitespace-tolerant search — **no citation grammar involved** |
| "Is this string citation-shaped / what does it key to?" | `citationKey.ts`, `caselawCitator.ts` | regex grammar + SQLite graph — **never touches a document's body text** |
| "Does this NUMBER appear in the sources?" | `legalTextAnchors.ts` | value-canonicalized anchor diffing, two-way |

### (a0) ⚠ The one that is already on the LAB — and its measured result

`C:\Users\elias\Desktop\MikeOSS Fork\benchmarks\harvey-labs\harness\mike_workbench.py`,
`_linked_grounding(grounding, markdown, deliverable)` (~468–548), active only when
`surface_name == "mike_one_shot_linked_grounding_xhigh_v1"` (~36, ~232). The
load-bearing lines:

```python
pattern = r"\s+".join(re.escape(token) for token in re.split(r"\s+", quote))
match = re.search(pattern, source_text)
if match is None:
    entry_errors.append("quote_not_verbatim")
```

Whitespace-tolerant, **case-sensitive and NOT quote-glyph-tolerant** (unlike every
TS sibling). Ellipsis is a hard reject (`quote_has_ellipsis`, ~498). It emits
receipts carrying `source_sha256`, `quote_sha256`, `verified`, `linked`,
`locator: "chars N-M"`, and counters `grounding_claims / grounding_verified /
grounding_linked`.

**Measured** — `docs/harvey-labs/protocols/harvey-lab-mike-linked-grounding-preregistration-2026-08-03.json` (~11):

> "Only 120 of 298 prior ledger quotes verified. All 178 unverified rows named a
> real resolved source; 131 contained model-inserted ellipses that the contiguous
> verifier correctly could not treat as verbatim."

That is the single most useful number in this wing: **~40% verbatim-verification
rate, with ellipsis insertion as the dominant failure mode, not fabrication.**

### ⚠ False-positive trap when auditing this wing

`MIKE_GROUNDING_FIRST` is set by `lab-beaver-arm.ts` (~888, ~905, ~1003) and
resolves to `GROUNDING_FIRST_ENABLED` (`localAssistantTools.ts` ~903) — but it is
consumed **only** at `routes/chat.ts` ~1116, to pick a system-prompt string. **It
is prompt-only and verifies nothing.** Do not read it as grounding machinery.

### (a) Intra-document verbatim quote verification — BUILT, generic, importable

`C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\sourceDoc.ts`:

- `createTextSourceDoc(text): SourceDoc` (~302) — wraps any plain text (the
  header notes it exists precisely for *"a text-only artifact whose upstream
  representation has no structural blocks"*).
- `sourceDocQuoteWords(quote)` (~123) → normalized word tokens.
- `sourceDocPhraseSpans(doc, words, options)` (~610) → `SourceDocQuoteSpan[]`
  = `{ start, end, firstWord, lastWord }` — **exported, with char offsets**.
  Options: `{ block?, sameLine?, limit? }`. Header:

  > "Every occurrence of an exact word sequence, in document order. Matching is
  > lowercased word equality over WORD_RE tokens, so a quote that verifies here
  > verifies everywhere."

- `sourceDocContainsQuote(doc, quote, block?)` (~685) — the boolean wrapper.
- Performance is already solved: word postings + line-break index, *"the
  difference between 2.6 s and 20 ms per quote on the Criminal Code."*

So the checker itself is **three calls wide**:
`sourceDocPhraseSpans(createTextSourceDoc(sourceText), sourceDocQuoteWords(claimedQuote))`.

`sourceDocQuoteText(text)` (~112) is the normalizer that makes it tolerant: it
strips outer quote marks, resolves editorial alterations (`[T]he` → `The`,
`[emphasis added]` → `emphasis added`), turns `...`/`…` into a gap, and collapses
whitespace. Net tolerance: whitespace-, punctuation-, case-, and
quote-glyph-insensitive.

**Three more checkers, at different strictness — pick per use:**

- `quotationOccurs(documentText, quotation): QuotationCheck` —
  `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\evalValidators.ts`. The
  cleanest standalone: returns `{ found, method: "exact" | "normalized" | null }`
  — raw `includes` first, then the normalized path. Header: *"Fabricated or
  altered quotations fail both paths."* Only consumer is
  `backend/src/lib/evalRunner.ts` (~124). Siblings in the same file:
  `seededIdentifierLeaks`, `forbiddenSources`.
- `deterministicClaimSupport(claim, state)` —
  `legalEvidenceExperiment.ts` (~1564). The **strict verbatim tier**: *"the
  normalized claim body must be a contiguous substring of ONE cited passage and at
  least 25 characters."* Its private `normalizeQuote` (~1518) folds only
  whitespace/curly-quotes/dashes/NBSP/ellipsis — *"Case and every substantive
  character are preserved — a one-word substitution inside a quotation must not
  survive this."*
- `locateQuote(haystack, needle)` —
  `backend/scripts/legalbench-rag-grounding.ts` (~218). Returns exact original
  `{start, end}` after trying `indexOf`, then a regex joining words with `\s+`
  and mapping `"`/`"` → `["""]`. Whitespace- and glyph-tolerant **while still
  returning exact coordinates** — the shape a span-emitting checker wants.

Companion repair: `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\chat\quoteRepair.ts` —
`nearestVerbatimExcerpt(claimBody, spanText)` (~56) → `{matched, claimTokens,
score, excerpt}` via longest contiguous common token run (O(n·m) DP), and
`quoteRepairSuggestion(claimBody, spans)` (~104), which refuses below
`score < 0.5`. Ported in approach from ALR-Quote-Verifier.

### (b) The grounding harness that consumes it

`C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\chat\legalEvidenceExperiment.ts`
is a full grounded-answer surface: tools `submit_grounded_answer`,
`plan_grounded_evidence`, `verify_grounded_claims`, `verify_grounded_answer`;
10 experiment modes (`compose_check`, `evidence_first`, `holistic_check`,
`tiered_check`, `quote_first`, `attested_framing`, `required_slot`,
`witness_panel`, `lint_gated`, `arbitrary_source_spans`); typed claims
(`LegalClaimKind = "quotation" | "conclusion" | "premise_correction"`); and
frozen thresholds `STAGE7_LINT_THRESHOLDS` computed by
`scripts/freeze-stage7-thresholds.ts` on the RegLab expert-label validation set
(*"94 grounded / 7 misgrounded / 5 ungrounded responses"*). It consumes
`sourceDocContainsQuote`, `quoteRepairSuggestion`, and `lintLegalClaim`
(`backend/src/lib/legalClaimLint.ts`, with `alienPhrases`).

**This is a public-legal-source surface (cases, legislation, journals), not a
document-set surface.** It is wired to `MIKE_GROUNDING_FIRST` /
`legalEvidenceExperimentMode()`, and the LAB default block sets
`MIKE_GROUNDING_FIRST: "0"`.

### (c) Citation machinery proper — and the US/Canadian asymmetry

- `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\citationKey.ts` (93 lines)
  — the single canonical surface. `citationLookupKey(value)` (NFKC → dash/dot/slash
  folding → casefold → squeeze; `"RSA 2000, c A-4.2"` → `"rsa2000ca4dot2"`),
  `citationsInText(text): CitationMatch[]` = `{text, start, end}`,
  `hasCitationInText`. Header rule: *"a new citation regex in a consumer file is a
  defect."* **The grammar is Canadian-only** (`2016 SCC 27`, `2015 CSC 5`,
  `[2019] 4 S.C.R. 653`, `112 O.R. (3d) 321`, `CanLII \d+`), calibrated on 3,000
  random citator edges.
- `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\caselawCitator.ts` (659 lines)
  — Canadian note-up graph: `noteUpCitations`, `standsForProfile`,
  `citationAliasKeys(Batch)`, `graphStats`. Backed by a 2.1 GB read-only
  `noteup.sqlite` under `%LOCALAPPDATA%\ALR Quote Verifier\citator\` (env override
  `MIKE_CITATOR_DB`).
- `citatorExcerpts.ts` — `classifyCitatorExcerpt` → `prose | mixed |
  authority_list | insufficient`, typed refusal, measured on 3,000 edges.
- `chat/tools/citatorTools.ts` — `CITATOR_TOOLS`, `executeCitatorTool`.
- `chat/citations.ts` — parses the model's `<CITATIONS>` block into typed
  citations; shape/URL work only, hands quote verification off to
  `legalSourceLinks` → `sourceDocContainsQuote`.
- `legalReferenceGrammar.ts` is **not** case-citation — it is intra-instrument
  provision pointers ("Section 2.05 of the Credit Agreement", "alinéa b)").

**US coverage is shallow and mostly Python-side.**
`backend/src/lib/courtlistenerLocalBulk.ts` does volume/reporter/page lookup
against the local mirror (`lookupLocalCourtlistenerCitation`,
`searchLocalCourtlistenerCases`). **eyecite exists only in two Python research
scripts** — `backend/scripts/fetch_reglab_sources.py` (~52) and
`segment_reglab_claims.py` (~34) — never in the TS product. **`courts-db` is a
mention only** (`docs/harvey-labs/archive/legal-grounding-research-plan-2026-07-30.md` ~291); no code.
**US Bluebook-format validation (signal, order, short-form, `id.`) does not exist
anywhere.**

### (d) The unused bridge worth knowing about

`C:\Users\elias\Desktop\MikeOSS Fork\backend\scripts\anchor-coverage-stdin.ts`
reads `{sources, drafts, max_rows_per_class, compiler_review, attention_text}` on
stdin and emits the anchor-coverage report or, with `compiler_review: true`, a
triaged shape:
`{status: "review_required" | "clear", relevant_or_repeated_source_anchors_missing_from_draft,
draft_anchors_absent_from_sources, repeated_anchor_contexts_not_evidenced_in_draft,
numeral_word_mismatches, counts, caution}`.
**It has zero callers anywhere in the tree** — a ready-made, hand-invokable
number-grounding bridge that no arm uses. It is the shortest path to a
number-grounding wing that does not require turning on the whole SLA stack.

### Deploy gap for a draft-verification wing

The verifier exists; **the harvester does not.** Nothing in the repo takes a
finished deliverable and extracts (i) the strings it presents as quotations and
(ii) the numbers/dates it asserts, to feed them to `sourceDocPhraseSpans`. What
exists nearby:

- For **numbers/dates**: `extractAnchors` (wing 10) already pulls money, percent,
  date, duration with offsets out of *any* text including a draft — and
  `anchorCoverage(sources, drafts)` already partitions them into
  matched / source-only / **draft-only**. `draft_only` rows are, in effect,
  *"the deliverable asserts a figure no source states"* — a number-grounding
  check that already runs inside `auditSlaDraft` and is already in the SLA
  receipt (`SlaAudit.receipt.classes[cls].draft_only_rows`).
- For **quoted strings**: nothing extracts quotation spans from a deliverable.
  A quotation harvester (paired quote marks, block quotes, `"…"` runs above a
  minimum word count) is small but new.

---

## 9. Redline / tracked-changes extraction

**Status: BUILT, and deliberately unwired.**

### What is built

`C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\docxTrackedChanges.ts`:

- `extractDocxBodyStructure(bytes)` (~789) → `DocxBodyStructure`
- `extractDocxBodyText(bytes)` (~919) — the **accepted view** plane that
  `find`/`context_before`/`context_after` match against
- `extractTrackedChangeIds(...)` (~929)
- `applyTrackedEdits(...)` (~958) — rewrites a `.docx` so substitutions appear as
  `<w:ins>` / `<w:del>` rather than direct replacements
- `insertTrackedBlocks(...)` (~1448), `resolveTrackedChange(...)` (~1670) — accept
  or reject one change by `w:id`
- Header: *"Pre-existing tracked changes in the paragraph are presented to the
  matcher in accepted view: w:ins runs are treated as normal text, w:del wrappers
  are invisible."*

`C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\docx\redline.ts`:

- `projectDocxRedline(...)` (~216) → `RedlineProjection { text, counts:
  { tracked_insertions, tracked_deletions, comments, ink_insertions,
  ink_deletions }, notes }`.
- **This is the markup-aware text server.** CriticMarkup-style vocabulary,
  quoted from the module header:

  > `{++inserted++}` w:ins · `{--deleted--}` w:del (w:delText restored) ·
  > `{>>author: text<<}` comments.xml body · `{++text++}[ink]` red run with no
  > tracked-change markup · `{--text--}[ink]` struck run with no tracked-change markup

  > "The `[ink]` suffix is attribution, not decoration: a manual redline is a
  > human's formatting, not a revision the package records, and the reader must
  > not be able to confuse the two."

- It also guards ambiguity: `MARKER_SEQUENCES` detects the marker strings
  occurring in the document's own text.

### The measured danger

Module header, verbatim — this is the "struck-text-reads-as-operative danger
measured" the memory records:

> "This exists because every text extractor we measured (mammoth raw text,
> mammoth HTML-to-text, pandoc plain) reads a struck-through deleted clause back
> as operative text — see scripts/probe-manual-redline.ts. **It is a read mode,
> deliberately not wired into any extraction default.**"

The probe is `C:\Users\elias\Desktop\MikeOSS Fork\backend\scripts\probe-manual-redline.ts`
(`npx tsx scripts/probe-manual-redline.ts`), which builds a fixture with
`new TextRun({ text: "$117,000", strike: true })` followed by
`new TextRun({ text: " $125,000", color: "FF0000" })` and a struck
`"This indemnity survives termination."` — i.e. the danger case is a **stale rent
figure and a deleted indemnity both reading as operative**.

Corroborated from the other direction by
`docs/harvey-labs/results/docx-capability-conformance-2026-08-03.md`: tracked changes are *"flattened
with no warning"* on the markdown wire, and that doc names this as *"the blind
spot the bench's `redline-already-deleted` / `redline-struck-carveout` tasks
measure."*

### Wired into any arm today?

No. `projectDocxRedline` is called from the conformance suite and from the
mike-redline-related paths only; the serving path (`servedDraftingText` →
`extractDocxDraftingSource`) uses the **accepted view**. The four chassis arms
see struck text as operative text.

### Deploy gap

1. A flag that swaps the served plane to `projectDocxRedline(...).text` for
   documents whose `counts` are non-zero (or unconditionally, for a redline arm).
2. **Offset re-basing.** The projection inserts `{++`/`--}`/`[ink]` markers, so
   every offset in the projected plane differs from the accepted-view plane. This
   collides with the wing-6 plane discipline and the wing-4 exposure denominator
   (`served_body_chars`) — a redline arm needs its own consistent plane end to
   end, exactly as the SECT-INDEX arm needed `bodyOffset`.
3. A decision about whether `find_in_document` searches the marked or the
   accepted plane (the wing-6 caveats apply verbatim).

---

## 10. Date / amount / party extraction utilities

**Status: BUILT for dates, amounts, percents, durations — with offsets and canonical value keys. ABSENT for party/entity names.**

Defined terms get their own wing below (**10b**), because the machinery there is
a different shape (a resolver + a dependency listing, not a value extractor) and
because it is substantially further along than a first read suggests.

### The core primitive — has offsets, and canonicalizes

`C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\legalTextAnchors.ts`,
`extractAnchors(text)` (~463) → `AnchorHit[] = { cls, raw, norm, index }`.

- **Offsets: YES** (`index`; consumers derive `end` as `index + raw.length`).
- Classes (`AnchorClass`, ~26): `money | percent | ratio | date | duration | area
  | statute | cite`.
- Grammar: `MONEY_RE` (~119; `$1,500,000`, `$2.25MM`, `$500K`, `1.5 million`,
  range inheritance `$40–$50 million`), `FR_MONEY_TRAILING_RE`/`FR_MONEY_WORDS_RE`,
  `DATE_TEXTUAL_RE` ("March 13, 2024"), `DATE_DAY_FIRST_RE` ("13 March 2024"),
  `DATE_DAY_OF_RE` ("the 15th day of March, 2027"), `DATE_NUMERIC_RE`,
  `DURATION_RE`/`DURATION_PAREN_RE`/`WORDED_DURATION_RE` ("thirty (30) days",
  "dix-huit mois"), `PERCENT_RE`, `RATIO_X_RE`.
- **The `norm` field is the join key a discrepancy sweep needs:** `"$2.25 million"`
  and `"$2,250,000"` both normalize to `money:dlr:2250000`; `"March 15, 2027"` and
  `"3/15/2027"` both to `date:2027-03-15`.
- Documented limit (~19–21): month-year mentions ("March 2027") are **not** date
  anchors.
- Plane: the flat text produced by `extractLocalDocument` (mammoth/PDF/XLSX
  flattened, cached). No back-mapping to DOCX runs or PDF coordinates at this layer.
- Tests: `backend\src\lib\__tests__\legalTextAnchors.test.ts` (454 lines — the
  heaviest in the family).

### The set-vs-set diff that already exists

- `anchorCoverage(sources, drafts, opts)` (~888) — partitions two document *sets*
  by `norm` into matched / source-only / draft-only, with counts, doc lists,
  excerpts, `verbatim: boolean`, and `AnchorRow.at` (first occurrence in
  `documents[0]` only). Exposed as tool `library_anchor_coverage`
  (`localAssistantTools.ts` ~8414) **and** used by `auditSlaDraft`.
- `bilingualConcordance(english, french, opts)` (~964) — a thin wrapper reporting
  anchors present in one language version only. Tool
  `library_bilingual_concordance` (~8600). **This is literally a two-document
  discrepancy sweep**, specialized to EN/FR pairs.
- `numeralWordPairs(text)` (~711) — offsets; catches "thirty (25) days".

### The reconcilers

- `conflictScan(documents)` — `backend/src/lib/legalConflictScan.ts` (~212).
  Richest ref shape in the codebase: `FigureRef { document, display, value,
  excerpt, at, verbatim, section }` — offset **plus** a resolved skeleton section
  label, via a lazily compiled `sectionResolver` (~166). Emits
  `scope: "cross-document"` (~49) — **but** the cross-document join path is gated
  on `OCCUPANCY_RE = /occupi|occupanc|leased|vacan|lou[ée]/` (~109), i.e. it is
  effectively welded to real-estate occupancy percentages. `sum_of_parts` is
  same-document only. Tool: `library_conflict_scan` (~8453).
- `temporalScan(documents)` — `backend/src/lib/legalTemporalScan.ts` (~230).
  `TemporalRef { document, display, value, excerpt, at, verbatim, section }`.
  **⚠ Despite taking a document array, `scope` is hardcoded `"same-document"`
  (~47) and the matcher runs inside a per-document loop (~241) — it never
  compares a date in doc 1 against a date in doc 2.** Not exposed as a tool.
- `derivedValueScan` / `deadlineOmissionScan` — wing 2; both offset-carrying,
  both `sources → one draft` shaped, neither exposed as a tool.
- `computeDeadline(opts)` — `backend/src/lib/legalDeadlines.ts` (~284). A
  *calculator*, not an extractor: structured input → date + `DeadlineTraceStep[]`
  audit trail, with `holidaysFor()` and `isBusinessDay()`. Tool `library_deadline`.

### Party / entity names — does not exist

There is **no party or entity-name extractor anywhere in the repo.** The only
entity-aware code is `ENTITY_WORDS` (`legalUndefinedTermScan.ts` ~115) — a set of
~60 designators (`inc`, `llc`, `ltd`, `gmbh`, `sàrl`, `pty`, `plc`, `bv`, `nv`,
`oyj`, …) used as a **negative filter**: a capitalized phrase containing one is
classified as a proper noun and *suppressed* from undefined-term findings. It
never emits an entity with an offset. There is no preamble parser, no signature-
block parser, no "between X and Y" party grammar.

### Dependencies

`backend/package.json` has **zero** NLP/date/entity libraries — no `chrono-node`,
`compromise`, `date-fns`, `luxon`, or spaCy bindings. The only linguistic deps
are `nspell` + `dictionary-en`/`dictionary-en-ca` (spellcheck). All date math is
hand-rolled UTC arithmetic (`shift()` in `legalTemporalScan.ts` ~128;
`holidaysFor()` in `legalDeadlines.ts` ~236). Everything above is hand-written
regex.

### The benchmark dir contributes nothing reusable

`benchmarks/harvey-labs/harness/tools.py` and `ablation_tools.py` are generic
grep/read/glob sandbox tooling; their only regexes are `_HEADING_RE`, `_PAGE_RE`,
`_REFERENCE_RE` (~148–154) and their `offset` field is **line-based read
pagination, not char offsets**. `evaluation/` is judge aggregation and charting.

### Honest verdict for a cross-document discrepancy sweep

**Dates and amounts: mostly ASSEMBLY. Names: entirely new.**

Already in hand: the offset-carrying, bilingual, canonically-keyed extractor
(`extractAnchors`); a working set-vs-set diff engine (`anchorCoverage`, proven as
a discrepancy report by `bilingualConcordance`); offset → citable section label
(`sectionResolver`); the `verbatim`/`excerpt`/`at` quotability contract; the
typed-`abstentions`/`refusals` report shape; and full cross-document definition-
body divergence (`termDriftReport`).

**The one genuinely missing step is N-way "same semantic slot, different value"
clustering.** Every existing tool answers *"is this key present on both sides?"*
(set membership). A discrepancy sweep asks *"these documents all state a Closing
Date — do they agree?"*, which requires grouping anchors by a **semantic slot**
and comparing values *within* the group. `anchorCoverage` cannot express this:
`date:2024-03-13` and `date:2024-03-14` are simply two unrelated keys that each
appear on one side. The closest existing seed is `labelBefore()`
(`legalConflictScan.ts` ~201), which walks back from a figure to the previous
anchor to grab its owning label — currently used only to spot "Total"/"Subtotal".

Also missing: party/entity extraction (100% new); named-date resolution ("the
Closing Date" → ISO, which would mean joining `termDriftReport` definition bodies
against `extractAnchors` output); `temporalScan`'s same-document weld (real
surgery, not a flag flip); `TermDefinition`'s dropped offset (2 lines); and an
orchestrator — the four sharpest organs are reachable only through
`slaWorkflow.ts` in a fixed sources-vs-one-draft shape, so a sweep over a flat
document set with no privileged "draft" needs a new entry point.

Realistic estimate: a dates+amounts sweep is a new ~200–300 line module that
calls `extractAnchors` per document, harvests a label per anchor (generalizing
`labelBefore`), buckets by (label, class), and reports buckets with >1 distinct
`norm` — reusing `sectionResolver` and the `FigureRef` shape verbatim.

---

## 10b. Defined-term resolver — conventions, validation side, reuse

**Status: BUILT for 3 of the 4 definition conventions. The cross-document
dependency listing is BUILT, tested, tool-exposed — and silently discarded by
the audit that computes it. The extraction half is already factored and reused
four times; the merged form is private.**

This wing was under-covered in the first pass and is the one with the largest
gap between "what the repo already does" and "what anyone knows it does".

### The four definition conventions, and which are detected

| Convention | Detected? | Where |
|---|---|---|
| Parenthetical — `(the "Term")`, `(each a "Unit", collectively the "Units")` | **YES** | `collectDefinedTerms` "Style 1" — `backend/src/lib/docxStructuralLint.ts`, `text.matchAll(/\(([^()]{1,200})\)/gu)` then `"([A-Z][A-Za-z0-9&'\- ]{0,79})"` inside the parenthetical |
| Definition-list entry — `"Term" means / shall mean / has the meaning / shall have the meaning / is defined as / includes` | **YES, three times over** | `collectDefinedTerms` "Style 2" (line-anchored `^"…"\s+means…`); `DEFINITION_RE` in `legalTermDrift.ts`; a whitespace-tolerant `DEFINITION_RE` in `legalUndefinedTermScan.ts` |
| **Definition-section heading** — "ARTICLE I — DEFINITIONS", "1.01 Defined Terms" | **NO** | Nothing locates a definitions article/section by its heading. The raw material exists and is already parsed: `SkeletonNode.heading` (`legalTextSkeleton.ts`, `SkeletonNode` ~56–67) carries `"DEFINITIONS"` / `"DEFINITIONS AND ACCOUNTING TERMS"` verbatim, and the skeleton test suite asserts on exactly those strings. A `/^defined?\s*terms?$|^definitions?\b/iu` match over `skeleton.nodes[].heading` is the whole missing step. |
| **Cross-document definition import** — "Capitalized terms used but not defined herein shall have the meanings ascribed to them in the Credit Agreement" | **YES — and this is the find the first pass missed entirely** | `INCORPORATION_RE` / `incorporatesDefinitions(text)` in `backend/src/lib/legalTermDrift.ts` |

The import detector is worth quoting, because it is a real two-clause grammar
with order-independence, not a keyword match:

```ts
const UNDEFINED_HERE = String.raw`(?:not|unless|except\s+as)\s+(?:otherwise\s+)?defined`;
const TAKES_MEANING  = String.raw`(?:has|have|shall\s+have)\s+the\s+meanings?\s+(?:set\s+forth|assigned|ascribed|given|specified)\b`;
const INCORPORATION_RE = new RegExp(
  `\\bterms\\b.{0,160}?\\b${UNDEFINED_HERE}\\b.{0,160}?\\b${TAKES_MEANING}` +
    `|\\b${UNDEFINED_HERE}\\b.{0,160}?\\bterms\\b.{0,160}?\\b${TAKES_MEANING}`,
  "iu",
);
```

It is whitespace-normalized before testing (`text.replace(/\s+/gu, " ")`), so it
survives PDF/DOCX line wrapping. Its module comment states the purpose exactly:
*"the document imports its vocabulary on purpose, so an undefined use there is
not a gap."*

A near neighbour, distinct in purpose: `POINTER_BODY_RE` in the same file
rejects an *intra*-document pointer body (`"Event of Default" has the meaning
set forth in Section 7`) so *"two addresses differing is not two definitions
differing"*.

### The dependency listing already exists — and is thrown away

`termDriftReport(docs, opts)` returns, alongside the drift rows:

```ts
/** term used in a document that neither defines nor apparently imports it */
importedUses: TermUseGap[];            // { term, definedIn: string[], usedIn, occurrences }
/** rows dropped because the using document expressly incorporates definitions */
suppressedImportedUses: number;
/** per-document count of definition-list terms found */
definitionCounts: Record<string, number>;
```

The build loop (in `termDriftReport`, the `// Imported uses:` block) does
precisely what a "defined-term dependency listing" needs: for every term defined
*somewhere* in the stack, it counts whole-word occurrences in every document
that does *not* define it, and routes the row to `suppressedImportedUses`
instead of `importedUses` when `incorporatesDefinitions()` fired on that
document. It requires `docs.length > 1` and skips terms under 4 chars.

**Where it goes:**

- **Product path — surfaced.** Tool `library_term_drift`
  (`localAssistantTools.ts`, handler `if (call.name === "library_term_drift")`)
  spreads the whole report into the tool result, so `importedUses`,
  `suppressedImportedUses` and `definitionCounts` all reach the model. Requires
  ≥2 `document_ids`; `max_rows` clamps 1–100, default 40.
- **⚠ SLA audit path — computed, then dropped.** `auditSlaDraft`
  (`backend/src/lib/chat/slaWorkflow.ts`) calls `const drift = termDriftReport(stack);`
  and then reads **only** `drift.shared`, filtered to `status === "divergent"`
  and further to rows touching `DRAFT_NAME`, gated on
  `termDriftRepairEligible = requestsOperativeDrafting(...)`. `drift.importedUses`
  and `drift.suppressedImportedUses` are never read — not into a finding line,
  not into the receipt. The dependency listing is being computed on every SLA
  audit and discarded.
- **LAB path — unreachable.** `library_term_drift` is not on any chassis arm's
  tool surface (they carry `UPSTREAM_MIKE_RETRIEVAL_TOOLS` + one `generate_docx`
  variant), and it is in `SLA_COMPILER_REPLACES` (`localAssistantTools.ts`), so
  when `MIKE_SLA_WORKFLOW=1` it is *removed* from the callable surface anyway:
  *"These organs become compile-time checks under the SLA workflow."*

### The validation side — "defined terms without definitions"

Two different checkers, at different scopes:

1. **`undefinedTermScan(sources, draft)` — `backend/src/lib/legalUndefinedTermScan.ts`**
   (776 lines; `undefinedTermScanStats` alongside). This is H3 from wing 2. It is
   the *stack-scoped* checker: a capitalized phrase the draft **uses** that
   nothing in sources + draft defines. `UndefinedTermFinding.at` **is** a char
   offset ("char offset of the first unquoted use in the draft, for quoting").
   Its design is quoted in its own header, and the load-bearing choice is the
   quoting/using boundary:

   > "A phrase whose occurrences all sit inside quotation marks is a
   > quotation/description, never a use; only phrases with at least one unquoted
   > occurrence are candidates. (Measured on the grounded-cache indenture stack:
   > 113 of 245 candidate phrases were quoted-only mentions.)"

   Suppression machinery, all reusable as-is: `PHRASE_RE` (Title-Case runs with
   compound connectors only), `DETERMINER_RE`, `POSSESSIVE_RE`,
   `CROSS_REFERENCE_RE`, `ENTITY_WORDS` (~60 international designators),
   `TRAILING_ENTITY_RE`, `OFFICE_TITLE_RE`, `isJurisdiction()`, `quoteMask()`,
   `definitionBodyMask()`, `isHeadingLine()`, `decomposesIntoDefined()`.
   Measured basis in the header: *"245 phrase candidates, 830 defined-term forms
   extracted across the stack, 1 fired."*
   Probe: `backend/scripts/undefined-term-probe.ts`
   (`npx tsx scripts/undefined-term-probe.ts` from `backend/`), which runs it over
   the vendored indenture task.

2. **`checkDefinedTerms(texts)` — `backend/src/lib/docxStructuralLint.ts`**, the
   *single-document* lint. Emits `defined_term_duplicate` (`"X" is defined N
   times`) and `defined_term_unused` (`"X" is defined but never used elsewhere in
   this document`), each with `paragraph_index` + `excerpt`. Abstains with a note
   when no quoted terms are found. Reachable in product as
   `library_lint_docx_structure`; also in `SLA_COMPILER_REPLACES`.

Note the asymmetry: `checkDefinedTerms` catches **defined-but-unused**;
`undefinedTermScan` catches **used-but-undefined**; `importedUses` catches
**used-here-defined-elsewhere**. Three sides of the same square, all built, none
wired to a chassis arm.

### Can the extraction half be reused? — yes, it already is

`collectDefinedTerms(texts: string[]): Map<string, number[]>` is **the canonical
shared extractor and is exported**, with four independent consumers:

| Consumer | File | What it supplies as `texts[]` |
|---|---|---|
| `checkDefinedTerms` | `docxStructuralLint.ts` | `paragraphTexts(documentXml)` — paragraph indices |
| `buildDefinedTerms` | `legalTextSkeleton.ts` (→ `AgreementSkeleton.definedTerms`) | `lineTexts` — line indices, then resolved to an owning `SkeletonNode.label` |
| `definedTermSet` | `legalUndefinedTermScan.ts` | `text.split("\n")` — line indices |
| `definedTermEdges` | `legalCrossReference.ts` | `lines.map((line) => line.text)` — the dormant TERM graph layer |

**Correction to the first pass:** the `number[]` values are indices into the
`texts[]` array the *caller* supplied (paragraphs or lines, caller's choice) —
they are **not** document indices, and they are **not** char offsets.

The genuinely merged form — parenthetical + list-entry + whitespace-tolerant
`"Term" means`, with singular/plural variants folded in — is
`definedTermSet(documents)` in `legalUndefinedTermScan.ts`. It is
**not exported** (plain `function definedTermSet`). That single missing `export`
is the difference between "assemble a resolver from parts" and "call the
resolver that exists".

Its companion `termVariants(term)` (also private) is the pluralization folder,
with an explicitly stated strictness bias: *"Extra invented variants are
harmless: they can only make a phrase MORE likely to resolve, never more likely
to fire."*

### Offsets: what carries one and what does not

| Producer | Offset? |
|---|---|
| `UndefinedTermFinding.at` | **YES** — char offset of first unquoted use in the draft |
| `TermDefinition` (`legalTermDrift.ts`) | **NO.** The internal `RawDefinition` computes `start` and `extractDefinitions` returns it; `termDriftReport` feeds it to `sectionLabelAt(nodes, def.start)` and then **does not copy it onto the emitted `TermDefinition`**. Recovering it is a one-field change. |
| `TermUseGap` (`importedUses`) | **NO** — carries `occurrences` (a count) but no offsets. Getting offsets means keeping the `matchAll` indices instead of taking `.length`. |
| `DefinedTermEntry` (`legalTextSkeleton.ts`) | **NO** — `sectionLabel` only, though the owning `SkeletonNode` has `start`/`end` |
| `collectDefinedTerms` | **NO** — caller-array indices only |

### Measured results

Thin, and this should not be overstated:

- `undefinedTermScan` (H3): the indenture-stack header measurement above, plus
  the corpus stress test — *"Organs fired at least once on: derived 20 runs,
  deadline 22 runs, undefined 43 runs"* with **448 undefined findings** and
  detail strings of 151/163/177/235 chars (min/med/p90/max), and the honest
  self-assessment that its detail *"names the term and the source count, but not
  which documents were searched"*
  (`docs/harvey-labs/results/harvey-lab-deterministic-stress-test-2026-08-03.md`). H3 is the driver
  of the repair prompt blowing past the 3,000-char skimming bound. Ledger
  verdict: *"H3 undefined-term stays off (proper-noun floods)."*
- `termDriftReport` / `importedUses` / `incorporatesDefinitions`: **no corpus
  measurement anywhere.** Unit tests only
  (`backend/src/lib/__tests__/legalTermDrift.test.ts`, which does assert the
  suppression path: `suppressed.importedUses` length 0 with
  `suppressedImportedUses` 1, vs `reported.importedUses[0].usedIn === "plain.txt"`).
  No fire-rate, no precision, no false-positive count on the LAB corpus.

### Honest verdict: assembled, not new — with two exceptions

**A defined-term resolver + dependency listing is ~85% assembly.** In hand:
three of four conventions detected, an import-clause detector with
order-independent grammar, a merged extraction set with plural folding, a
whole-word cross-document use counter, a suppression list for proper
nouns/entities/jurisdictions/office titles/headings, quote- and
definition-body masking, and an already-shipping tool that returns the listing.

Genuinely new work, and only this:

1. **Definition-section heading detection** — trivial, one predicate over
   `skeleton.nodes[].heading`, but it does not exist.
2. **Offsets on `TermDefinition` and `TermUseGap`** — one field and one
   `matchAll` retention respectively.
3. **`export` on `definedTermSet` / `termVariants`** — one keyword each, or
   accept duplication.
4. **A path to the listing on a chassis arm** — `importedUses` is currently
   reachable only through a tool the chassis does not carry, and is dropped by
   the audit that computes it. This is a wiring problem, not a build problem.

The one thing that would be *research*, not assembly: resolving an import to its
**named target** ("…in the Credit Agreement" → which attached document is that).
`incorporatesDefinitions` returns a boolean; it does not capture the instrument
name. `legalReferenceGrammar.ts` (`isExternalReferenceInContext`) is the nearest
existing machinery for naming an external instrument.

---

## 11. Assembly assessment — the three composite deployments

### (A) Coverage certificate + scoped-claims discipline

*Prove which spans were never served; force negative assertions to carry a
coverage basis.*

| Part needed | Wing | State |
|---|---|---|
| Per-document served-span record | 4 | **Persisted** in `beaver-receipts.json` (`tool_results[].evidence_segments`); **computed then discarded** in `exposureMetrics`'s local `byDocument` |
| Per-document denominator on the served plane | 4 | **Ships** — `source_receipts[].served_body_chars` |
| Interval complement arithmetic | 4 / 6 | **Ships twice** — `uncovered()` (`evidenceExposure.ts` ~198) and `mergeIntervals`/`coveredLength` (`localAssistantTools.ts` ~2131–2159) |
| One coordinate space for reads + finds | 6 | **Ships on the index arm only** (F3, `evidenceBase`); the e2e/swap arms have a *known intentional* read-vs-find plane mismatch |
| Unread-span → section label | 5 / 6 | `sectionResolver` (arm-independent) or the SECT-INDEX spine (arm-gated) |
| Claim → coverage-basis binding | 3 | **Does not exist.** Nothing relates deliverable sentences to exposure ranges |
| The design for the assertion discipline | 3 | **Lost.** Only the disposition line survives |

**Build gap.** The *certificate half* is small and almost entirely plumbing:
return `byDocument` from `exposureMetrics`, complement it against
`served_body_chars`, label the gaps, and emit. This has already been done
manually — `docs/harvey-labs/results/harvey-lab-phase-c-criteria-forensics-2026-08-05.md` §4 prints
a real 10-block span map for `credit-agreement.docx` and attributes 7 criterion
failures to named gaps — so the reconstruction is proven, just not automated.
Do it as a **post-hoc receipt** first: zero model tokens, and it directly answers
the standing objection that coverage-checking is a whole-read in disguise.

The *scoped-claims half* is genuinely new and needs a design that no longer
exists in the repo. Its empirical case is strong and specific: banking index
C-011, where the arm *"did not merely omit the conflict, it asserted its
absence"* over a span (`§2.05(b)`) it never read. Note the honest scoping
constraint: exposure-gap is 31 of 106 Phase C misses but **all 31 are on
scoped-read arms**; every whole-read cell has zero. On the winning whole-read
chassis this wing has, by construction, nothing to certify — it is a wing for
*scoped* arms, or for whole-read arms whose documents exceed the window.

### (B) Cross-document discrepancy sweep (dates / amounts / names)

| Part needed | Wing | State |
|---|---|---|
| Offset-carrying date/money/percent/duration extractor | 10 | **Ships** — `extractAnchors`, with canonical `norm` join keys |
| Cross-document set diff | 10 | **Ships** — `anchorCoverage`; `bilingualConcordance` proves the report pattern |
| Offset → section label for citing a discrepancy | 10 / 5 | **Ships** — `sectionResolver` |
| Cross-document *value* reconciliation | 10 | **Partial** — `conflictScan` emits `scope: "cross-document"` but only through the occupancy-gated path; `temporalScan` is hardcoded same-document |
| Definition-body divergence across docs | 10b | **Ships** — `termDriftReport(...).shared`, divergent-first (but the definition offsets are dropped) |
| Cross-document defined-term *dependency* (used here, defined there) | 10b | **Ships** — `termDriftReport(...).importedUses`, with import-clause suppression; dropped by the SLA audit, reachable via `library_term_drift` |
| **Semantic-slot clustering (same slot, different value)** | 10 | **Missing — this is the real gap** |
| Party / entity extraction | 10 | **Absent entirely** |
| Named-date resolution ("the Closing Date" → ISO) | 10 | **Absent** |
| An entry point over a flat document set (no privileged draft) | 2 / 10 | **Absent** — every organ is `sources → one draft`, behind `MIKE_SLA_WORKFLOW` |

**Build gap.** Assembled, not new, for dates and amounts: ~200–300 lines
implementing slot-harvesting (generalize `labelBefore`) + bucketing by
(slot, class) + reporting buckets with >1 distinct `norm`, plus a flat-document-set
entry point. Genuinely new for names.

**Task-fit note the study should weigh.** The benchmark already contains the
exact target shape: `benchmarks/harvey-labs/tasks/capital-markets/compare-closing-documents-against-closing-checklist`
(work_type `review`) whose criteria are literal cross-document discrepancies —
C-002 *"an aggregate principal amount of $275,500,000 instead of the correct
$275,000,000 — a $500,000 discrepancy"*; C-003 a staleness date comparison
(certificate dated February 26, 2025 vs the checklist's "no more than 5 business
days prior to the March 14, 2025 closing"). **But headroom on that task is
nearly gone**: Phase C scored it 29/32, 28/32, 29/32, 29/32 across four arms,
with only 1 task-hard miss (C-009). A sweep would need to be measured on a task
family where discrepancy criteria are still failing, or the study measures a
ceiling.

### (C) Draft-verification pass

*Quote-ground the numbers in the deliverable against source docs, plus H1/H2 on
the draft, plus a defined-term dependency listing.*

| Part needed | Wing | State |
|---|---|---|
| Post-draft audit stack + one revision pass + drift re-audit | 1 | **Ships end-to-end**, `MIKE_SLA_WORKFLOW=1` |
| H1 derived-value organ | 2 | **Ships**, measured "ready for live A/B", never run as a judged arm |
| H2 deadline organ | 2 | **Ships**, same |
| Number-grounding ("draft asserts a figure no source states") | 10 / 1 | **Already running inside the audit** — `anchorCoverage`'s `draft_only_rows` are exactly this, and they are already in the SLA receipt |
| Verbatim quote verification, tolerant, with offsets | 8 | **Ships, arm-independent** — `sourceDocPhraseSpans(createTextSourceDoc(text), sourceDocQuoteWords(q))` |
| Near-miss quote repair | 8 | **Ships** — `quoteRepairSuggestion`, `nearestVerbatimExcerpt` |
| **A harvester that pulls quoted strings out of a finished deliverable** | 8 | **Missing** — small but new |
| Defined-term extraction (parenthetical + `"X" means` + plural folding) | 10b | **Ships** — `collectDefinedTerms` (exported, 4 consumers); merged form `definedTermSet()` is **private** |
| "Draft uses a term nothing defines" | 10b / 2 | **Ships and already runs in the audit** — H3 `undefinedTermScan`, offset-carrying; but measured noisy (448 findings / 43 runs) and the ledger keeps it off |
| **Defined-term dependency listing** ("this document uses N terms defined only in the Credit Agreement") | 10b | **Ships as `termDriftReport(...).importedUses`, and `auditSlaDraft` computes it then drops it.** Surfacing it into the repair prompt/receipt is a few lines, and it is the *cheap* half of the defined-term story — a listing, not a finding |
| Import-clause suppression ("capitalized terms used but not defined herein…") | 10b | **Ships** — `incorporatesDefinitions` / `INCORPORATION_RE`, order-independent, whitespace-normalized |
| Definition-section heading detection | 10b | **Missing** — one predicate over `skeleton.nodes[].heading`, which already carries `"DEFINITIONS"` |
| Receipt sink | 1 | **Ships and is already pointed at the run dir** — `MIKE_SLA_RECEIPT_PATH` → `results/<runId>/sla-receipts.jsonl` for every arm |
| Arm registration + conformance gates | 1 | **Blocked, on two gates** — see below |

**Build gap.** This is the cheapest of the three composites and the closest to a
one-flag deployment — with a hard blocker that is **two** gates, not one:

1. **The prompt-sha conformance gate must be taught about the SLA prompt
   section.** `chat.ts` does `systemPrompt += slaLedger.promptSection` and hashes
   the result; `lab-beaver-arm.ts` computes
   `expectedPromptSha = sha256(expectedSurface.systemPrompt + inventoryPromptFor(documents, arm))`
   and throws `"<arm> served the wrong system prompt"`. Any SLA-on arm dies on
   the first round until `armExpectedSurface` appends the same section.
1b. **⚠ The chassis isolation gate hard-asserts SLA is OFF.** Immediately after
   the prompt-sha check, the same block throws `"<arm> isolation failed"` when
   any of a long conjunction holds — and two of its clauses are literally
   `surface?.sla_workflow !== false` and `surface?.greenfield_review !== false`.
   So even with the prompt hash fixed, a `MIKE_SLA_WORKFLOW=1` chassis arm still
   throws. The isolation predicate must become arm-aware (the way
   `structureIndex` / `completenessFloor` already are, computed per-arm just
   above it). **This is the single most concrete "built but not runnable" fact in
   the whole inventory, and the first pass recorded only half of it.**
1c. **Tool-surface side effect.** `MIKE_SLA_WORKFLOW=1` also *removes* six tools
   via `SLA_COMPILER_REPLACES` in `localAssistantTools.ts`
   (`library_lint_docx_structure`, `library_anchor_coverage`,
   `library_conflict_scan`, `library_term_drift`, `library_drafting_lint`,
   `library_bilingual_concordance`) — *"These organs become compile-time checks
   under the SLA workflow."* On the current chassis this is inert (none of the
   six is resident), but the isolation gate also compares
   `JSON.stringify(residentTools) !== JSON.stringify(expectedTools)`, so it
   matters for any richer-surface arm.
2. **All-or-nothing organs.** `auditSlaDraft` runs seven organs; there is no
   per-organ selector. An "H1/H2 only" arm needs a small options addition
   (H3 should be off — measured proper-noun floods at cap on 26/43 runs).
3. **Prompt-delta discipline.** Leave `MIKE_SLA_STRATEGY` unset so the delta is
   the ~200-char gated-checks sentence, not the full Spec→Ledger→Draft→Audit→
   Grounding workflow (whose live cells measured *"roughly 470k–2.15m tokens per
   task without a reliable accuracy win"*).
4. **Repair-prompt budget.** Measured p50 3162 / p90 4486 chars against a
   documented 3,000-char skimming bound, with H3 the driver — dropping H3 should
   bring it under.
5. **Quote-grounding is additive and optional.** The number half is free (already
   in the receipt as `draft_only_rows`). The quote half needs the harvester.
6. **Compatibility unverified.** The revision pass re-invokes `runProvider` and,
   for artifact deliverables, instructs the model to revise the library document
   with tools. The SLA stack has never been run on the claude-p lane or with
   `MIKE_TERMINAL_AUTHORING=1`. That combination is a smoke-test item, not a
   known-good.
7. **The defined-term dependency listing is the cheapest addition of all.**
   `auditSlaDraft` already calls `termDriftReport(stack)` on every audit and
   already pays for `importedUses`; it just never reads the field. Surfacing it
   costs no new extraction, no new pass, and no model tokens if it goes to the
   receipt only. Unlike H3 it is a *listing*, not an accusation — "these 14 terms
   are used here and defined only in `credit-agreement.docx`" is informational,
   so the H3 false-positive risk does not transfer to it. Its one honest weakness
   is that it has **zero corpus measurement** — unit tests only.

---

## 12. Doc-vs-code mismatches (consolidated)

1. **`plans/iridescent-puzzling-church.md` does not exist.** The ledger's "FIX
   WAVE A1-A6 LANDED" section cites it as the approved plan. There is no `plans/`
   directory anywhere in the repo. (The *commits* it describes — `28741fa6`,
   `360836ae`, `76e54625`, `248e864e`, `e14b83b8`, `207ab5a7`, `d00f2f1e`,
   `1b4ecebb` — all exist and are verifiable in `git log`.)
2. **Task #28 "Design absence-loop + coverage-assertion mechanisms" is marked
   completed, but no design artifact exists in the tree.** Only the one-line
   disposition in the ledger's Cut section survives. See wing 3.
3. **`docs/harvey-labs/design/harvey-lab-harness-features-plan-2026-08-03.md` §6.1 is stale in a way
   that matters.** It is still present-tense ("A subagent is auditing…", "update
   this doc when it lands") and gates H7–H9 on an audit that never landed as a
   doc — while a *later* and harsher verdict on the same question exists in
   `docs/harvey-labs/archive/harvey-lab-index-arm-ideas-ledger-2026-08-05.md` §4/§7/§9 (in-degree
   anti-correlated with misses; "salience-ranked index (twice-negative)" on the
   Killed list). Two documents in `docs/` give opposite impressions of whether
   centrality is "pending" or "dead".
4. **The ledger's own "Efficiency thesis CONFIRMED" and "quality neutral within
   noise" conclusions are explicitly overturned later in the same file** (TRIPLE
   AUDIT, "Corrected conclusions" 1 and 2). The file is a living document and
   both texts remain. Anyone quoting the RUN RESULT section without reading past
   it will quote a retracted claim. Not a code mismatch, but the same hazard.
5. **`f1150a9d` fixed three distinct anchoring-correctness bugs (F2, F6, F7) and
   added no new tests**; the "10/10 passing" cited in its message is the
   pre-existing suite from `98f4f182`.
6. **Minor:** `docs/harvey-labs/design/harvey-lab-harness-features-plan-2026-08-03.md` §6.3 pins
   dependencies to line numbers that have since moved
   (`slaWorkflow.ts:426–578` for the audit stack; `auditSlaDraft` is now ~549 and
   the stack runs to ~843). Content anchors, not line numbers, should be used.
7. **No precision/recall exists for H1/H2/H3 anywhere**, despite "ready for live
   A/B" language. The stress test says so in two places. Treat "zero false
   positives" as a single-stack observation.
8. **The conformance suite does not cover `upstreamNativeDocxRenderer.ts`** — a
   second markdown→docx path being added now. **Confirmed on re-check:** the file
   now exists on disk (untracked, ~24 KB, alongside modified
   `localAssistantTools.ts` and `upstreamMikeBenchmarkSurface.ts`) and appears in
   **zero** `describe`/`it` blocks of
   `backend/src/lib/__tests__/docxCapabilityConformance.test.ts`. The conformance
   claim in `docs/harvey-labs/results/docx-capability-conformance-2026-08-03.md` covers
   `renderDocxMarkdown` only.
9. **Not doc-vs-code, but inventory-vs-code — corrected here.** The first pass of
   *this* document mis-stated two things about the defined-term machinery, and
   both mattered:
   - It reported `collectDefinedTerms`'s `Map<term, number[]>` values as
     *"document indices"*. They are indices into whatever `texts[]` array the
     caller passes — **paragraphs** for `checkDefinedTerms`, **lines** for
     `buildDefinedTerms` / `definedTermSet` / `definedTermEdges`.
   - It missed `INCORPORATION_RE` / `incorporatesDefinitions` and the entire
     `importedUses` / `suppressedImportedUses` half of `termDriftReport`, which
     is exactly the "cross-document definition import" convention and the
     "defined-term dependency listing" the study was asking whether it had to
     build. It does not. See wing 10b.
10. **`auditSlaDraft` computes `termDriftReport(stack).importedUses` on every
    audit and never reads it.** Not a doc mismatch — a live dead-code path where
    an already-paid-for deterministic signal is discarded before it can reach
    either the repair prompt or the receipt.

---

## 13. Sources consulted

Code (absolute paths): `backend/src/lib/chat/slaWorkflow.ts` ·
`backend/src/routes/chat.ts` · `backend/src/lib/chat/evidenceExposure.ts` ·
`backend/scripts/lab-beaver-arm.ts` · `backend/scripts/lab-compare.ts` ·
`backend/src/lib/chat/localAssistantTools.ts` ·
`backend/src/lib/chat/structureIndexExperiment.ts` ·
`backend/src/lib/chat/tools/documentOps.ts` ·
`backend/src/lib/chat/legalEvidenceExperiment.ts` ·
`backend/src/lib/chat/quoteRepair.ts` · `backend/src/lib/sourceDoc.ts` ·
`backend/src/lib/legalTextAnchors.ts` · `backend/src/lib/legalDerivedValueScan.ts` ·
`backend/src/lib/legalDeadlineOmissionScan.ts` · `backend/src/lib/legalUndefinedTermScan.ts` ·
`backend/src/lib/legalConflictScan.ts` · `backend/src/lib/legalTemporalScan.ts` ·
`backend/src/lib/legalTermDrift.ts` · `backend/src/lib/legalCrossReference.ts` ·
`backend/src/lib/legalDocumentNavigator.ts` · `backend/src/lib/legalProvisionGraph.ts` ·
`backend/src/lib/docxTrackedChanges.ts` · `backend/src/lib/docx/redline.ts` ·
`backend/src/lib/chat/labOutlineInjection.ts` ·
`backend/src/lib/__tests__/docxCapabilityConformance.test.ts` ·
`backend/scripts/dv-generalization-scan.ts` · `backend/scripts/deterministic-stress-test.ts` ·
`backend/scripts/probe-manual-redline.ts` · `benchmarks/harvey-labs/harness/mike_workbench.py`

Added in the second pass (wing 10b + the two-gate blocker):
`backend/src/lib/docxStructuralLint.ts` (`collectDefinedTerms`,
`checkDefinedTerms`) · `backend/src/lib/legalTextSkeleton.ts`
(`SkeletonNode`, `buildDefinedTerms`, `DefinedTermEntry`) ·
`backend/src/lib/legalStructureSidecar.ts` ·
`backend/src/lib/chat/upstreamMikeBenchmarkSurface.ts`
(`UPSTREAM_MIKE_LAB_TOOLS`, `UPSTREAM_MIKE_MARKDOWN_SWAP_LAB_TOOLS`,
`MARKDOWN_INDEX_LAB_TOOLS`) · `backend/scripts/undefined-term-probe.ts` ·
`backend/src/lib/__tests__/legalTermDrift.test.ts`

Docs: `harvey-lab-index-arm-ideas-ledger-2026-08-05.md` ·
`harvey-lab-phase-c-criteria-forensics-2026-08-05.md` ·
`harvey-lab-harness-features-plan-2026-08-03.md` ·
`harvey-lab-deterministic-operationalization-2026-08-03.md` ·
`harvey-lab-deterministic-stress-test-2026-08-03.md` ·
`harvey-lab-adversarial-audit-2026-08-03.md` ·
`hybrid-retrieval-v13-adversarial-audit-2026-08-02.md` ·
`docx-capability-conformance-2026-08-03.md` ·
`upstream-mike-native-surface-spec-2266446b.md`

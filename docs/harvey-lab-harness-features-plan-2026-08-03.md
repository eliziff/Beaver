# Harvey LAB harness features — hypotheses & rationale

Date: 2026-08-03 · Scope: Beaver harness A/B on the Harvey LAB benchmark (vendored at `benchmarks/harvey-labs/`) · Status: hypotheses for approval, not yet built or preregistered

This document records *what we believe about the failure modes, and which harness-side features we think attack them*, before any of them are built. Each hypothesis carries its evidence, its mechanism, its predicted effect, and its test. The goal is a defensible work queue that raises scores without ballooning tokens.

---

## 1. Basis — what the data established

### 1.1 Failure clusters across the 15 graded runs (213 missed criteria)

| Cluster | Misses | Concentrates in |
|---|---:|---|
| Quantification / derived amounts | ~99 | CoC (46), Tax (19), Indenture (19), Banking (5) |
| Dates / working-back deadlines | ~47 | CoC (26), Indenture (11), Tax (6), Banking (4) |
| Specific citations / statutes / precedents | ~37 | Indenture (12), CoC (10), HSR (7), Tax (8) |
| Named-entity / party / defined-term coverage | ~16 | CoC upstream (8), Indenture (5), HSR (3) |
| Output structure (tables / columns / completeness) | ~10 | Tax (4), Closing (2+), CoC |
| Severity taxonomy (Critical/Significant/Administrative) | 7 | Closing only |
| Cross-doc semantic consistency | ~8 | CoC, Tax, Indenture, Closing |

Source: `benchmarks/harvey-labs/results/2026-08-03-*/scores.json` (15 runs), clustered by subagent 2026-08-03.

### 1.2 Coverage is a stable core plus a shuffled tail

Across the 12 paired v1/v3 runs, failed-criteria Jaccard overlap was 1.6–13× above chance on every surface; passed sets are stable (0.77–0.97 overlap). The model reliably covers the same good majority; a bounded tail shuffles around a fixed recurring core. An up-front coverage commitment can at best convert some tail misses on mid-tier surfaces (fail-Jaccard 0.39–0.53: closing mike, coc mike, coc grounded, indenture grounded). **The bulk of the gap is a deterministic recurring core — the right instrument for that core is deterministic harness work, not a prompt-level commitment.**

### 1.3 The upstream change-of-control collapse is deterministic, not noise

`upstream_terminal_v1` on CoC: 5/57, 4/57, 3/57 across three independent experiments; failed-set Jaccard 0.944, 50/55 distinct fails common to all three runs. This is a stable surface/skill failure, *not* coverage roulette, and no coverage-commitment mechanism can fix it. Treated as a separate workstream (see §6.2).

### 1.4 Token parity — the whole-read is not what the edge was

Beaver's early token-efficiency edge was turn-count/context-resend, not a whole-read difference; it converges to parity against upstream_mike. The retained surface is therefore: host-side exact normalization + receipts, **one evidence fetch, one model authoring turn**, deterministic DOCX render. Any new feature must not reintroduce turn-churn.

### 1.5 Injected deterministic facts do not convert to analysis (fact-index)

The `mike_one_shot_fact_index_xhigh_v1` arm (typed-anchor index, 8 rows / 2–6K chars) scored 169/225 — last of the four one-shot arms, dominated on banking (superset failure set) and tax. Decisive case: it failed tax C-007 (India 12%-vs-15% markup inconsistency) *while holding the exact anchor in its own injected index*, and lost banking C-065 (a Revolver maturity the certificate literally tabulates). **Lesson: "give the model a better-annotated context" is a weak lever; "the harness does the work deterministically" is the strong one.** Drop the arm (see §3.1).

---

## 2. Governing constraints

1. **Never inject the hidden rubric** into the drafting model (`criteria[].match_criteria` is gold; real legal work hands you no rubric). Harness features may use only the request text + sources + whatever the model itself derives. (See `memory/beaver-harness-spec-direction`.)
2. **Spec/plan artifacts must be model-derived** — the model writes its own acceptance spec from the prompt/env; the harness materializes and gates on it, never supplies it.
3. **No token blowup.** New features emit *bounded findings* (<1–2K tokens) or pre-seed structure that *saves* output tokens. No multi-turn loops; keep the one-fetch/one-authoring-turn shape.
4. **Judge = per-token OpenAI API** (`evaluation.run_eval --judge-model gpt-5.6-sol`); drafting arms run the flat-rate codex route (`codex:gpt-5.6-luna`, per `run_mike_grep_four_way.ps1`). No per-token drafting spend.
5. **Measure first** (repo doctrine): every feature becomes an arm with a preregistered run, scored against the retained baseline on the same tasks; no deterministic change without a corpus/gold number.
6. **Sealed tier off-machine** (LAB corpus split rule) — exposure recorded, manifest regenerated.

---

## 3. Decisions already taken

### 3.1 Drop `mike_one_shot_fact_index_xhigh_v1`
Dominated: composite 169/225 is last; banking failure set is a strict superset of plain xhigh; indenture's 73/83 (+1 over control) sits inside the task noise band with no replicate. §1.5 evidence.

### 3.2 Retain the smallest two-tool whole-read surface
Consistent with the prior consolidated doc (`harvey-lab-mike-one-shot-context-results-2026-08-03.md`): review loops and extra tools cost tokens for zero gain.

### 3.3 Spec artifact priced as a variance-reducer, not a score-raiser
See §1.2. Build it cheaply for harness shape (§4 H6); do not expect it to move the stable core.

### 3.4 Upstream CoC collapse is its own workstream
Deterministic surface failure (§1.3); hypothesis about cause in §6.2 pending a targeted probe.

---

## 4. Feature hypotheses

Each feature: **H** (claim) · **R** (rationale/evidence) · **M** (mechanism) · **P** (predicted effect) · **T** (test).

### H1 — Derived-value completeness audit (omission mode)

- **H:** The dominant quantification failure is not wrong arithmetic but the draft *engaging a whole/percent (or component/total) relationship and omitting the derived value*.
- **R:** ~99 of 213 misses are quantification; CoC examples (C-008 "$22.1M/25.3%", C-026, C-040, C-042, C-050, C-051) show the draft holding the percent or the component but never the implied dollar. The extraction machinery already exists: `legalConflictScan.ts` percent_of_whole identity (~line 293).
- **M:** In the existing post-draft `auditSlaDraft` stack (`slaWorkflow.ts:426–578`, `stack = sources + draft`), add an *omission* mode: when a source states a whole + percent pair and the draft restates the percent but never the implied part, emit one bounded finding. One cheap repair pass, exactly as the audit organs already run.
- **P:** Converts a large share of the ~99 quantification misses into found-and-fixed findings at <1–2K tokens (vs a full re-read + re-draft revision pass today). Largest single lever.
- **T:** Arm with omission-mode audits enabled vs the retained baseline on CoC + Tax tasks; count newly-passed quantification criteria.

### H2 — Deadline working-back calendar check (omission mode, same shape as H1)

- **H:** Date/deadline failures are the same omission disease in the time domain: the draft holds "consent request 60 days before the Oct 15 closing" but never states the resolved mid-August date.
- **R:** ~47 misses; CoC C-014/C-018/C-024/C-037/C-038/C-039 are all working-back-from-Oct-15; Tax C-028/C-058 (Japan Mar 31, India Nov 30).
- **M:** Reuse `legalTemporalScan.ts` (`temporalScan`, ~line 230) in the same audit stack, omission mode: source date − duration → resolved date must appear in the draft's timeline/next-steps.
- **P:** Converts the bulk of the ~47 deadline misses via the same bounded-finding mechanism.
- **T:** Same arm as H1 (both are modes of the audit); judge on CoC + Tax.

### H3 — Defined-term forward-reference check

- **H:** The draft references capitalized terms it never defines (in sources or draft), and this is a stable miss the model does not self-correct.
- **R:** Indenture C-077 ("Permitted Tax Distributions" referenced, never defined) failed in **all three grounded arms and** the fact-index run (4 criteria); CoC C-044 similar. Extraction already exists: `legalTermDrift.ts` (`termDriftReport`, ~line 182) + `buildDefinedTerms` (`legalTextSkeleton.ts:1345`).
- **M:** Scan the draft's capitalized defined-term-style phrases; flag any resolving to no definition in sources+draft. ~200-token finding.
- **P:** Eliminates this stable class by construction (the finding names the exact undefined term).
- **T:** Arm on Indenture + CoC; also the natural seed for H8 (risky-term detector).

### H4 — Deliverable table/field scaffold from the request

- **H:** Output-structure misses (missing risk-quantification table, missing deadline/responsible-party fields, missing checklist-item column) happen because the deliverable's shape is left entirely to the model.
- **R:** ~10 misses but high-leverage: Tax C-001/C-003/C-065/C-066 (4 in one run), Closing C-029 (67% of discrepancies carry a checklist ref, < 75% bar), CoC C-036 (aggregate column missing).
- **M:** Pre-seed the output skeleton with the tables/columns **the request itself names** (derive from request text only — never the criteria, per §2.1), rendered through the existing `generate_docx` structured sections/table schema (`upstreamMikeBenchmarkSurface.ts:129,214`). The model fills cells; required fields exist by construction.
- **P:** Converts silent omission into impossible omission at near-zero token cost.
- **T:** Arm on Tax + Closing; measure newly-present required fields.

### H5 — Memo/letter header-block renderer

- **H:** Header/address lines fail stably and cheaply (all 3 HSR arms mis-addressed the memo).
- **R:** HSR C-001 failed in all 3 arms ("from Mike, AI Legal Assistant" instead of the required from/to); parties are named in the request/sources.
- **M:** Genre-specific pre-render of the To/From/Date/Re block from the request's named parties, via the H4 scaffold mechanism.
- **P:** Header right by construction for memo/letter deliverables. Tiny.
- **T:** Fold into H4's arm when a memo-genre task recurs.

### H6 — Model-derived spec artifact / harness goal state (borrowed from OSS harnesses)

- **H:** A first-class, host-persisted goal/checklist state improves the mid-tier shuffled tail (a few points) and gives the harness the shape of a proper coding harness — but does not fix the stable core.
- **R:** Coverage data §1.2 (marginal on tail); prior audit: the SLA Spec/checklist layer was prompt-only, never materialized. OSS research (subagent 2026-08-03): Codex `update_plan` is a ~100-line tool (`plan_spec.rs`+`plan.rs`, Apache-2.0) whose model-writes-checklist/host-persists shape is identical to Beaver's existing `checkpoint_research` gate (`evidenceExposure.ts`); Goose's `plan.md` + `classify_planner_response` (~30-line LLM call) gives a true spec-first gate that pairs with the already-built post-draft `auditSlaDraft`. pi has nothing in core — skip.
- **M:** Port Codex's `update_plan` as a Beaver tool (afternoon's work), or the Goose spec-first variant (plan.md template + classify + gate-drafting-on-nonempty-plan) for a true Spec step. Spec content always model-derived (§2.2).
- **P:** Reduces tail variance on mid-tier surfaces (a few points); delivers the goal-state architecture the harness lacks; explicitly *not* priced against the stable core or the CoC collapse.
- **T:** A/B the Goose-style spec gate vs retained baseline on the shuffled-tail tasks (closing mike, coc mike, coc grounded, indenture grounded).

### H7 — Cross-reference graph as lean-understanding (structure shown to the composer)

- **H:** The intra-contract reference graph is not a recall mechanism but *may* be a lean-understanding representation — the model understands a contract faster/better from its reference structure than from a whole read, at lower cost. It keeps losing to whole reads, and we need to find out whether that loss is fundamental or an artificial barrier (wrong tech / wrong representation / churn-inducing tool).
- **R:** `legalCrossReference.ts` header (self-measured, zero model calls): 2,428 resolved / 307 unresolved / 1,720 external / 4,779 refused of 9,234 references; 3.3% miss on accepted refs; gold-fragment recall wins on maud (2.28% vs 1.44% contiguous) but loses on cuad (1.15% vs 6.99%) and contractnli (4.06% vs 5.06%); only 31/227 maud gold fragments have any outgoing edge. Conclusion as written: "not a recall mechanism; if it earns arms it will be as structure shown to a composer."
- **M:** Pending §6.1 audit. If the representation/tool is the barrier: present the graph once, compactly (hub list + edge summary), not behind a per-section query tool.
- **P:** Hypothesis only. Could lower comprehension cost for the model's one authoring turn; could also be genuinely inferior to contiguous context on these tasks.
- **T:** Arm on CoC/Indenture where cross-referencing is dense.

### H8 — Deterministic risky-term detector (regex/grammar)

- **H:** High-risk clause machinery (defined-but-unreferenced terms, cross-referenced-but-undefined terms, "notwithstanding"/"sole discretion"/MAC language, indemnification caps, survival periods) can be *flagged* deterministically, and — per §1.5 — is only useful where the harness can also **verify**, not just show.
- **R:** Feasibility depends on the §6.1 audit of `legalReferenceGrammar.ts` coverage and §1.5's conversion lesson. Terms like "Permitted Tax Distributions" (H3) are the entry point.
- **M:** Extend `collectDefinedTerms` / `legalReferenceGrammar` with risk-pattern classes; emit a compact risk index. Used either as (a) an H1-style audit target or (b) a bounded injectable index — with (b) priced skeptically per §1.5.
- **P:** Unknown until audit; likely a sub-feature of H1/H3 rather than a standalone.

### H9 — Centrality-based importance ranking

- **H:** "Which provisions are most referenced, and which reference the most" — computed with standard graph math (degree/HITS/PageRank) over the existing LITERAL/TERM/LEXICAL edge sets — yields a truthful top-K hub list that lets the model prioritize without reading everything.
- **R:** The graph exists (`legalCrossReference.ts`); but centrality is only as good as the edges, and the header's own data shows weak edge density (31/227 maud fragments have any outgoing edge) and weak layers (LEXICAL redundant with bm25). Risk: hubs name boilerplate (definitions article, governing law) rather than the operative clauses.
- **M:** Pending §6.1 audit of edge quality. If clean: degree/HITS on literal+term edges, emit top-K hubs once.
- **P:** Hypothesis only; could cut comprehension cost or could be dominated by contiguous read like the recall results suggest.
- **T:** Arm on CoC where the reference graph should be dense.

---

## 5. Build order (pending approval)

1. **H1+H2** — omission-mode derived-value + deadline audit (one mechanism, two modes). Largest cluster (~146/213), reuses the live audit stack, tiny build.
2. **H4** — request-derived deliverable scaffold. Structural lever, anti-cheat boundary clear.
3. **H3** — defined-term forward-reference check. Same-week tiny win; seeds H8.
4. **H5** — memo header renderer. Cheap follow-on, genre-gated.
5. **H6** — spec artifact via borrowed OSS machinery (Codex `update_plan`, or Goose spec-first). After the deterministic slices are measured, so its marginal contribution is isolated.
6. **H7–H9** — graph/centrality/risky-term: only after the §6.1 audit lands.

---

## 6. Open questions and dependencies

### 6.1 Cross-ref graph audit (in flight)
A subagent is auditing: (a) correctness of `legalCrossReference.ts` / `legalReferenceGrammar.ts` detection (the header's self-measurement claims, dated), (b) how the LAB arms represent structure to the model — one compact injection vs a per-section query tool that forces churn, (c) edge-set cleanliness for centrality. H7–H9 hypotheses are written but their feasibility hinges on that audit; update this doc when it lands.

### 6.2 Upstream CoC collapse — cause probe
Deterministic across 3 runs (§1.3). Working hypothesis: the surface's memo misidentifies counterparties (Great Lakes/TerraVerde/Wellstone vs gold's Pinnacle/TerraNode/Orion-family) despite reading all 19 docs — either a model-side entity-identification failure at that surface or a source-extraction defect the harness produced. Probe before building anything on that task.

### 6.3 Dependencies
- H1/H2 audit stack location: `slaWorkflow.ts:426–578`; organs `legalConflictScan.ts:~293`, `legalTemporalScan.ts:~230`.
- H3: `legalTermDrift.ts:~182`, `legalTextSkeleton.ts:1345`.
- H4: `upstreamMikeBenchmarkSurface.ts:129,214`.
- H6 borrow sources: Codex `codex-rs/core/src/tools/handlers/plan_spec.rs`+`plan.rs`; Goose `crates/goose/src/prompts/plan.md` + `classify_planner_response` (local clones under `.tmp/harness-research/`).
- Judge: `evaluation.run_eval --judge-model gpt-5.6-sol` (per-token API, authorized).

---

## 7. Preregistered arm — `grounded_structure_outline_v1` (H7)

Arm `grounded_structure_outline_v1` — H7 one-time outline + top-K cross-ref
injection surface test. Built 2026-08-03; run preregistered, no judge spend.

This is the §6.1-audit follow-through: instead of a per-section query tool that
forces Grep→Read churn, the host injects the agreement structure ONCE into the
system context at surface build time — a compact outline per numbered source
(via `renderAgreementOutline`, bounded per document and in total) plus a
top-K most-referenced section summary over the graph's resolved literal edges
(`legalCrossReference.ts`). Deterministic, model-free, no new tools, no
multi-turn churn. A document that refuses (no numbered structure, source too
large, outline too big) contributes nothing rather than a truncated dump.

Implementation: `backend/src/lib/chat/labOutlineInjection.ts` (block builder +
`MIKE_GROUNDED_OUTLINE_INJECTION` flag); `GROUNDED_STRUCTURE_OUTLINE_LAB_SYSTEM_PROMPT`
in `backend/src/lib/chat/upstreamMikeBenchmarkSurface.ts`; runtime injection in
`backend/src/routes/chat.ts` after the AVAILABLE DOCUMENTS block; arm registered
in `backend/scripts/lab-beaver-arm.ts` (structure-paths tool surface, grounding
on, outline injection on). Existing arms are unchanged.

Predicted effect (H7, hypothesis only): either lowers comprehension cost for the
model's one authoring turn, or is genuinely inferior to contiguous context on
these tasks. Verified so far: `npx tsc --noEmit` passes; a model-free dry run on
`draft-indenture-for-senior-secured-notes-offering` produced a bounded outline +
hub block (indenture ~1.7K chars, credit agreement ~1.7K chars, email refusal
omitted; total 3,580 chars under the 6,000 total cap). No model run, no results.

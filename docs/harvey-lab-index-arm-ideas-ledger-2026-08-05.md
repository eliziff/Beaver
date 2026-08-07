# Index-arm ideas & theories ledger

Date: 2026-08-05 · Living document — revise in place as subagents land.

Scope: the derived-section-index arm (`mike_markdown_e2e_index_v1`) on the
Harvey LAB, the research question behind it, every theory/insight produced
around it, and the current cut of what is correctness vs. what is a post-run
test. This is the single capture point for the brainstorming thread of
2026-08-04 → 2026-08-05.

---

## 1. The research question

In previous attempts, **partial-read arms were (mostly) failures** — yet coding
agents never whole-read, and they do well on SWE-bench-style tasks. Why? Is the
coding-tool harness the difference, or is something about our legal-drafting
tasks fundamentally different?

Guiding puzzle: *"What are we missing? What makes coding so good vs. our tasks
where we can't parlay it into quality wins (even accepting much greater
costs)?"*

---

## 2. Established facts (from prior runs & the research sweep)

- **Partial-read arms were NOT complete failures.** Several won. The real
  failure was **token explosion + synthesis-completeness-despite-exposure**,
  not under-reading per se.
- **Whole-read controls are unreliable as a baseline.** The upstream arm
  scored 4/57, 37/57, 52/57 across three runs on the same task family — huge
  variance, so a single control run is a weak yardstick.
- **Coding agents succeed via the error oracle + reference graph.** In the
  literature, agents don't fail from under-reading; *more* context correlates
  with *lower* success. The feedback loop (compile error → fix) is what makes
  targeted reading safe.
- **Legal tasks lack that error oracle.** A missing clause or a wrong
  subsection doesn't crash — it just silently under-delivers. So scoped reads
  carry real risk with no built-in correction signal.
- **Synthesis is the hard part, not retrieval.** Best-ever lean_batch scored
  59/65 *while reading a fraction* — the model could synthesize correctly from
  bounded exposure when it knew what it needed.

---

## 3. The arm: derived SECT-INDEX

**Mechanism:** at `.docx` ingest, derive the section tree once (existing
skeleton detectors over the OOXML plaintext plane); serve it as a compact
address table prepended to the pandoc markdown; orient-first prompt directs
scoped `find_in_document` / offset `read_document` reads instead of whole-reads.

- **Key design finding:** subsection identity is *composed, not source text*
  — `Section 2.01(a)` is a label the skeleton derives (parent + `(a)` token);
  the markdown never states it. Pandoc does not flatten; `(a) Subject to…`
  paragraphs are literal.
- **Plane convention:** served = `SECT-INDEX + "\n\n" + markdown`; offsets are
  body-relative (`start = bodyOffset + offset`); head/tail and find are on the
  same served plane.
- **Silo:** one flag (`MIKE_STRUCTURE_INDEX`), one module
  (`structureIndexExperiment.ts`), one gated read-path branch, one prompt
  const, one arm entry. No detector touched.

### Trial result (covenants, 1 run, judged)

| | upstream whole-read (control) | index arm |
|---|---|---|
| Judge score | 54/65 | **56/65** (9 missed) |
| Total effective tokens | 88.3k (42.6k in + 45.7k out) | 92.6k (67.5k cache-adj in + 25.1k out) |
| Best-ever lean_batch | 59/65 | — |

**Verdict: quality was effectively a wash, and so was cost.** Slight win, but
at the same price. The lever is therefore not exposure — it's **round-trip
overhead** (52 tool calls each re-sending accumulated context).

### Miss taxonomy (9 criteria)

- **Synthesis:** C-001 (TNL ratio computation), C-026 (cure-limits↔step-down
  connection) — read but not connected.
- **Threshold detail:** C-048 ($15M aggregate trigger).
- **Read-gaps:** C-057/058 (grace periods in §8.01 — never read), C-064/065
  (maturity dates in read-but-not-extracted sections), C-052/053 (balance
  figures).

---

## 4. The salience hypothesis

**Claim:** document-internal, task-agnostic salience measures predict which
sections *must* be read to avoid misses. If true, the index can mark the
load-bearing sections so a scoped reader reads the right things.

### Candidate measures (oracle-tested, see §7)

1. **Cross-ref in-degree** — how many sections reference a section
   (`legalCrossReference.referenceHubs`). Proven in the H7 outline arm.
   Caveat from survey: graph is *sparse* (31/227 maud gold fragments have any
   outgoing edge) — a weak-but-correct signal, not recall.
2. **Defined-term density** — per-section count of defined-term *uses*
   (`definedTermEdges`, DORMANT today). "How many other sections depend on
   this definition."
3. **Operative (deontic) density** — per-section count of
   `shall|shall not|must|shall be deemed|covenants?|agrees?` +
   `provided that|notwithstanding|subject to|except as|unless`, normalized
   per 1000 chars. Grounded in ContraSum (prohibitions > obligations >
   entitlements in expert-rated importance) and deontic-modality sources.
   Orthogonal to in-degree: §8.01 Events of Default (the C-057/058 miss) is
   deontic-dense but has low in-degree.
4. **Centrality** — network centrality over the cross-ref graph.
5. **Cross-doc reference counts** — references from *other* documents in the
   matter (the compliance certificate / prior memo referencing the agreement).

### The discriminator that matters

Not "which sections are salience-dense" but *"for each miss, was the unread
section's density above the document median?"* — and does a cheap rule ("read
anything referenced elsewhere + anything above the 75th-percentile density")
reproduce the winning read decisions?

### ORACLE VERDICT (2026-08-05): HYPOTHESIS UNRESOLVED — the negative is selection-biased

**Eli's correction (2026-08-05): the "evidence was exposed" finding is banal.**
The judged population is whole-read dominated (`documents_read =
total_documents` in nearly every run). When a run reads everything, the
evidence being in the context window is definitionally true for every miss —
it is a constant, not a signal. It cannot discriminate scoped-read failures
from whole-read failures, because there essentially were no scoped reads to
fail. It says nothing about:

- **token cost** — never measured as a variable;
- **context-rot** — a genuinely clear window (low tokens / low dilution) may
  change performance independent of cost; no run in that population has a clear
  window to compare;
- **whether scoped reads change miss rates** — the very question the thread
  exists to answer.

What the oracle *did* show (honest residue): the salience test measured "does
salience predict which sections the model synthesizes wrong" in a world where
the model read everything — a read-targeting question it cannot adjudicate; and
the one genuinely scoped datapoint (§8.01 read yet grace criteria missed) is
**n=1 on a buggy arm** (F4 whole-read the index, F1/F3 broke the plane) — weak
in both directions. Meanwhile lean_batch's best-ever **59/65 was itself a
partial-read arm** — weak evidence *for* the read-side thread. See §7.

---

## 5. Adversarial audit findings (F1–F10)

The implementation pass found and tasked fixes for these. **Current cut: only
F1–F4 are correctness/run-blocking; F5–F7 keep only if nearly free; F8–F10
deferred.** (Batching, once F7's scope, moved to the post-run list — §9.)

- **F1** — `deepseek.ts` snapshots `resolveTools` result once before the loop;
  breaks the per-round contract. *Correctness, run-blocking.*
- **F2** — `anchorSubsection` regex matches unescaped `(x)` anywhere; must be
  parent-relative. *Correctness, run-blocking.*
- **F3** — evidence/read-state plane mismatch: offsets body-relative but
  head/tail/evidence served-plane. *Correctness, run-blocking* — this is why
  the claimed 56.5% exposure was really ~26.5%.
- **F4** — "read head: 20" unsatisfiable for a 311-line index → model
  whole-read `head:300` to see the index, blowing the budget. *Correctness,
  run-blocking* (prompt/surface defect).
- **F5** — `servedDraftingText` not memoized, recomputes per call. *Perf, not
  correctness.*
- **F6** — `anchorDisplayLineStart` only rejects letter/digit immediately
  after display. *Anchor edge case.*
- **F7** — `anchorSpine` 8-pass fixpoint collapses duplicate displays.
  *Anchor edge case.*
- **F8–F10** — deepseek resolveTools regression, evidence-plane mismatch
  variants, memoization family. (Rolled into F1/F3/F5; no separate work.)

Also audited and **verified clean**: the scoped-only gate is airtight — 3
unscoped whole-read attempts, all 3 rejected, 31 scoped reads accepted. (A
miner misread call IDs and claimed otherwise; verified against raw-sse.txt.)

---

## 6. Batching (round-trip reduction) — the efficiency thesis

**The efficiency thesis (Eli, 2026-08-05):** the read-side machinery is not
about quality — the oracle killed that claim. It's about **keeping the context
window truly clear**, which pays at minimum cache-adjusted token efficiency,
possibly model performance too. This is the surviving justification for the
whole index/scoped-reads/batching thread.

**Evidence it's untested:** the one trial was a cost wash (index 92.6k vs
control 88.3k effective) *because* the arm was buggy in exactly the ways that
eat token savings — F4 forced a whole-read (`head:300` to see the index, so the
context was never truly clear), 52 round-trips each re-sent the accumulated
context (cache-adjusted input 67.5k of the 92.6k), and F1/F3 left the planes
mismatched. A corrected + batched arm has never been measured on cache-adjusted
tokens.

**Goal crystallized:** same score at materially lower cache-adjusted tokens per
correct criterion. The lever stack, all efficiency, all still live:
1. **F4** — no whole-read, index reachable cheaply (context stays truly clear)
2. **Batching** — round trips 52 → ~25 (multi-query `find`, batched window
   reads, batch-then-read prompt discipline)
3. **F5 memoization** — `servedDraftingText` recompute
4. **Genuinely scoped reads** — the minimal index is what *enables* this, so
   the index itself stays even though salience annotations died

**Status: batching MOVED to post-run shortlist (§10).** Do not build before
the planned run.

---

## 7. Oracle search (running) — validate salience on judged runs

Purpose: before any live inference, cheaply test whether any deterministic
salience measure relates to the misses across already-judged runs.

Method: deterministic regex/ref-graph pass over served text per section;
relate misses to exposure (exact char ranges from `beaver-receipts.json`
`evidence_segments` vs. the source sections); score measures + the naive
rule. Contingency table decided whether any salience measure earns a slot.

### RESULT (agent `ace84c620ecfdc1ab`, done) — READ WITH THE SELECTION-BIAS CAVEAT

**CAVEAT (Eli, 2026-08-05): the judged population is whole-read dominated, so
"the evidence was exposed" is banal — it tells us nothing about token cost,
context-rot, or scoped-read miss rates. This analysis describes whole-read
runs; it does NOT adjudicate the read-side hypothesis. See §4.** With that
caveat, the deep-miss analysis:

- **Change-of-control (36/57, 21 misses):** 20/21 had the evidence exposed
  somewhere the model read (README → synthesis). The 5 never-read contract fee
  sections all had their figures duplicated in fully-read deal memos. Genuine
  never-read-failure ≈ 1–2/21.
- **Banking/covenants (56/65, 9 misses):** 9/9 had evidence exposed.
  **Correction:** C-057/058 were *read-then-missed*, not never-read — the
  trace shows a `read_document` covering §8.01 (chars 88345–93545) and a
  `find_in_document` hit (88695–88879) containing the grace text at 88708.
- **upstream_terminal contrast (4/57):** 19/19 docs read, 100% exposure, still
  collapses — reading everything does not prevent the failures.

Cross-tab (change-of-control, 646 sections / 15 miss; banking, 101 / 3):

| Measure | change-of-control miss vs non-miss | banking (n=3) |
|---|---|---|
| deontic/operative density | 53% above non-miss median (= chance) | 67% |
| cross-ref in-degree | 20% above median (**negative**) | 33% |
| defined-term density | 40% | 100% |
| cross-doc refs | 53% | 67% |
| section length | 53% | 100% |

**Verdict: the salience hypothesis is UNRESOLVED for read-targeting** (the
negative is contaminated by whole-read dominance — §4). Within whole-read runs,
the two contract-only misses (meridian §8.2, nova §2.1) had *low* operative
density, and high-density sections were read yet missed — but that is a
*synthesis* pattern in a world where reading wasn't the constraint. It does not
establish that a salience steer fails under genuinely-scoped reads. The
read-side thread stays live (corrected run is the test); only the overclaim
died.

**Higher-leverage arm (synthesis side, recommended by the oracle):** a
post-draft criteria-coverage self-audit — draft against the existing evidence
manifest, then require the model to assert-or-mark-absent each deliverable
requirement. C-026 (had both facts, didn't connect), C-057/058 (read the grace
text, didn't extract), and the upstream collapse all point here. (This is the
"completeness self-check before drafting" already allowed as general discipline
in the no-overfit doctrine — a mechanism, not a per-task checklist.)

Coverage limits: deep per-criterion analysis on 2 runs + 1 contrast (the other
291 inventoried at score/doc-coverage level); section-boundary attribution is
heuristic; the `.xlsx` certificate text wasn't fully reconstructable.

---

## 8. Codex ↔ DeepSeek wiring (research, done)

- **The historical blocker is gone:** `deepseek-v4-flash` now natively serves
  `/v1/responses` (Responses API), which is the *only* wire_api codex 0.146
  accepts (`wire_api = "chat"` is hard-removed). `v4-pro` does not yet serve
  it.
- The harness spawns `codex exec` as a subprocess (never calls the API
  directly); tools flow through a local MCP bridge → Responses `function`-tools.
- **Ranked options:** (1) custom `model_providers.deepseek` block injected via
  `-c` overrides through a `CODEX_EXEC_COMMAND` wrapper; (2) env-var redirect
  (`OPENAI_BASE_URL` + `CODEX_API_KEY`) — unverified vs `auth_mode="chatgpt"`;
  (3) existing native `deepseek-v4-flash` adapter + coding tool shape (already
  works, in-process loop); (4) small tracked code change (extend the LAB
  `deepSeekLane` exemption to `codex:deepseek-*` + inject the 5 `-c` args).
- **Gating catch:** the LAB validator's codex-lane receipts will likely reject
  a `codex:deepseek-v4-flash` run until the exemption is extended.
- **PARKED.** Native deepseek lane runs the arm fine; reopens only if we want
  the Codex native agent loop.

---

## 9. Deterministic-layer survey (done) — what exists & what to wire

Full module-by-module table in the agent report (`a56b1fe5bb9ace8ce`). Bottom
line and role-ranked picks:

### The ONE piece to wire first

**`crossReferenceGraph` (`referenceHubs` in-degree) into the SECT-INDEX.**
Trustworthy (3.3% miss on accepted refs, typed abstention on everything else)
and already on the arm's plane — `deriveSectionNodes` compiles the skeleton, so
the graph is one scan+resolution away. Appending per-line `N refs →/←` +
an unresolved-targets footer buys **both** requested signals (salience + cross-
ref defect flag) at once. Plumbing proven by the H7 outline arm.

**SUPERSEDED (2026-08-05) for the salience role by the oracle:** in-degree is
anti-correlated with misses, so the per-line ref-count steer is NOT worth
wiring. The graph retains value as the **(c) resolver** and as a completeness
footer (unresolved-targets flag), but not as a read-side salience annotation.

### Role-ranked picks

- **(a) Salience** — 1) `referenceHubs` in-degree (proven in H7; sparse but
  correct); 2) `definedTermEdges` use→definition in-degree (DORMANT, best
  second feature); 3) outline size column as cheap base-rate.
- **(b) Completeness** — SLA organ assembly: H1 derived-value (5 omissions =
  failed gold criteria, zero FPs) + H2 deadline (calibrates to a failed
  criterion) — both measured "ready for live A/B". `docxStructuralLint` is the
  shipped draft-level linter. **H3 undefined-term stays off** (proper-noun
  floods).
- **(c) Resolver** — `crossReferenceGraph` (definitive intra-doc), `definedTermEdges`
  (definitions), `readSection` (locator→span).

### Honest gaps (new work, no existing measurement)

- **"Model never read section N" check does NOT exist.** Raw materials exist
  (`readState.deliveredChars`, SECT-INDEX label list, `evidenceExposure`
  ranges) but the diff is new work. *Note: Eli's earlier cut — coverage-checking
  is a whole-read in disguise — argues this stays unbuilt.*
- `definedTermEdges` standalone salience value, `docxStructuralLint` FP rate,
  SECT-INDEX anchor reliability beyond the one covenants docx — all unmeasured.

---

## 10. The cut (2026-08-05)

### (1) Correctness — land before the planned run

F1, F2, F3, F4 only (see §5). F5–F7 fold in only if nearly free.

### (2) Post-run shortlist — after the corrected run

1. **Batching / round-trip reduction** (§6) — the cost lever for keeping the
   context window truly clear; independent of correctness, tests cleanly after
   the corrected run.
2. **Synthesis-side self-audit** — post-draft criteria-coverage self-audit
   against the evidence manifest — assert-or-mark-absent each deliverable
   requirement. Motivated by C-026, C-057/058, and the upstream collapse;
   allowed as general discipline per the no-overfit doctrine. **New candidate,
   user to confirm** — but note the evidence for it is whole-read-derived (§4
   caveat), so it's a second-priority hypothesis, not a settled verdict.
3. **Salience-ranked index** — *deferred, not dropped*: the oracle's negative
   is contaminated by whole-read dominance, so a salience steer is untested
   under genuinely-scoped reads. Only earns a slot if the corrected run shows
   scoped-read misses that correlate with section salience.

> Strategic reading (Eli, 2026-08-05): do NOT abandon the read-side thread on
> the oracle's evidence. The population is whole-read dominated; "it was in the
> context window" is banal and says nothing about token cost or context-rot.
> The corrected run is the first real test of a truly-clear window — quality
> AND cache-adjusted cost.

### Cut (dropped / parked)

- **Codex↔DeepSeek wiring** (§8) — parked; native lane suffices.
- **SLA lint organs as index-arm features** (H1/H2/docxStructuralLint/anchor-
  coverage) — drafting-audit surface, not the read path.
- **"Never-read section N" checker** — coverage-checking in disguise (user cut).
- **Centrality / cross-doc counts / rest of oracle menu** — only what the
  oracle confirms earns a slot.
- **H3 undefined-term** — proper-noun floods.
- **Absence-loop / coverage-assertion machinery** — designed then cut by user:
  not mostly an absence problem; per-section coverage checks are inefficient
  whole-reads.

---

## 11. Open questions

- **Re-opened (Eli, 2026-08-05):** does a truly-clear context window improve
  cache-adjusted token cost, and possibly model performance via reduced
  context-rot? The oracle's "synthesis is the binding constraint" is
  whole-read-selection-biased and banal (§4/§7) — the corrected run is the
  first real test, measuring quality AND cost against a whole-read control.
- Does a salience steer discriminate misses under *genuinely-scoped* reads?
  (Untested — the oracle only saw whole-read-dominant runs.)
- Does the synthesis-side self-audit (assert-or-mark-absent each deliverable
  requirement) actually reduce misses? (Post-run candidate #2 — evidence for it
  is whole-read-derived, so second priority.)
- Did the F1–F4 fixes hold under a fresh 4-task run with claude judge? (task
  #25, now gated on fixer only)
- Is round-trip reduction (batching) the dominant remaining cost lever, or
  does lean_batch's 59/65 suggest the read-discipline is already the ceiling?
- Whole-read control variance (4/57, 37/57, 52/57) — is any single control run
  trustworthy as a baseline?

---

## Pending lands (update these on arrival)

| Agent | Topic | Status |
|---|---|---|
| `ace84c620ecfdc1ab` | Oracle salience validation (§7) — **FAILED hypothesis, re-scoped** | done |
| `abe90012c9e7e2357` | F1–F4 correctness fixes (F5–F7 fold-if-free) — committed `f1150a9d`, verified | done |
| `adf764b164f6dd23e` | Codex↔DeepSeek wiring (§8) | done |
| `a56b1fe5bb9ace8ce` | Deterministic-layer survey (§9) | done |

### Fixer verification (coordinator, 2026-08-05) — all claims confirmed independently

- Commit `f1150a9d` = exactly the 4 fix-list files, pathspec-staged, working tree clean
  of tracked changes (only untracked `.tmp-*` probes).
- `tsc --noEmit` clean; deepseek 4/4, structureIndexExperiment + localToolWiring
  43/43 pass.
- Covenants anchor probe: **PASS** — topLevel bad=0, subsection bad=0,
  8.01(e)(i) anchored @92007; the 4 unanchored are Exhibit-A form-bloc clauses
  (honest typed-absence, previously mis-anchored).
- The 1 failing test (`localAssistantTools` 47/48, "keeps oversized research
  results") is **pre-existing and unrelated** — line 6770 calls
  `result(call, publicLegalResult.payload)` (the `{payload}` interface from the
  concurrent session's legalEvidence checkpoint `fe46a53b`, which IS an ancestor
  of HEAD). When `payload` is undefined, `JSON.stringify(undefined)` → undefined
  → `serialized.length` throws at 5153. Not touched by F1–F7.
- Batching: fully reverted per scope cut; nothing in the tree or commit.

**Arm status: run-clean.** Gated run #25 (4 tasks, claude judge) can go.

## RUN RESULT (2026-08-05) — change-of-control, corrected index vs deepseek whole-read control

Both judged identically with `claude-code/claude-opus-5` via `claude -p`, same rubric:

| Metric | Control (whole-read) | Index arm (corrected) |
|---|---|---|
| **Score** | **49/57** (8 missed) | **47/57** (10 missed) |
| Docs read | 18/19 | **10/19** |
| Unique source exposure | ~full | **17.2%** |
| Tool calls | 52 | **24** |
| Input tokens | 278.9k | 233.3k |
| Cache-adjusted input | 84.8k | 72.0k |
| Output tokens | 39.1k | **19.9k** |
| Total tokens | 318.1k | 253.2k |
| Failed calls | 0 | 0 |
| Wall clock | 394s | **210s** |

**Headline: the efficiency win did NOT cost read coverage.** The 2-criteria
gap is synthesis, not read-gap:

- **C-022 (Orion §15.3):** model read body window [31500,40000]; §15.3's full
  text (90-day audit right + 30-day termination notice) is at body
  39638–39853 — **inside the window**. Evidence delivered, missed anyway.
- **C-029 (Webb Good Reason):** the SECT-INDEX head-read exposed the
  definition's enumerated breadth directly (1.10(i) diminution, (ii)
  relocation, (iii) salary reduction, (iv) material breach) — exactly what the
  criterion asks to flag. Evidence delivered, missed anyway.

Both index-only misses are read-then-missed — the same synthesis-failure class
the whole-read control exhibits (its 8 misses). The corrected scoped reads
delivered the right sections; the model didn't assemble them.

**Efficiency thesis CONFIRMED, quality thesis neutral (single run):** the first
genuinely-clear-window run matches whole-read quality within noise (47 vs 49,
and whole-read control variance is 4/57–52/57 across runs) at ~20% lower
effective input, ~50% lower output, ~40% less wall clock, 46% fewer docs
touched. lean_batch's 59/65 remains the best score on this task family.

**Open question carried forward:** C-022/C-029 read-then-missed on *scoped*
reads now corroborate the oracle's synthesis finding from a clear-window run —
but the fix direction (draft-side self-audit vs. something else) is still not
measured on a live run.

Next run (planned): `mike_markdown_e2e_index_v1` (corrected) vs upstream
control on 4 tasks — hsr, closing, covenants, employment — model
`deepseek-v4-flash`, judged via `claude-code/claude-opus-5`. No API spend.

## TRIPLE AUDIT (2026-08-05, Fable coordinator + 3 opus-5 auditors) — prior conclusions overturned

Three independent adversarial audits (machinery / evidence / strategy) of the
index-arm program. Several ledger conclusions above are now CORRECTED.

### Fatal machinery findings

- **D1 (fatal): the index arm's system prompt was never sent.**
  `MARKDOWN_E2E_INDEX_LAB_SYSTEM_PROMPT` is referenced only from the
  `--preflight-only` branch; `routes/chat.ts` has no `STRUCTURE_INDEX_ENABLED`
  prompt branch. Receipts prove it: `surface.system_prompt_sha256` is
  byte-identical across index/e2e/control on every task. The recorded
  `markdown_e2e_index_delta` is a false receipt. Every index run to date ran
  with the plain upstream prompt; all "orient-first" pressure came from tool
  descriptions + the scoped-read refusal gate.
- **D7: scoped-read-only was enforced on documents whose index has ~no
  addresses.** Anchoring rates on the real corpora: HSR 4/5 docs at **0%**;
  EMP playbook 0%, redline 7%; CoC webb 2%, terraverde 3%, pinnacle-license
  15%, both memos 0%. The 95% figure came from the single covenants tuning
  fixture. `hasIndex` = `bodyOffset > 0`, not "has usable @N offsets" —
  designed-in forced under-read. 4 of 5 CoC index-only misses map to
  low/zero-anchor docs.
- **D8 / head-budget bug: `head=N` slices N lines of the SERVED plane, so the
  SECT-INDEX eats the head budget.** CoC `fetch(head:120)`: apex-msa returned
  10,723 index chars and **0 body chars**; ~21% of the run's tool_result_chars
  was index scaffolding. EMP head=250 delivered 8% of the pivotal company
  draft. Also explains HSR "abandoned scoping" (line-sparse docs slid through
  whole).
- **D5/D6: `documents_read` counts zero-length exposures (CoC true coverage
  9/19, reported 10/19); past-end scoped reads return ok/empty with
  `past_end_tool_calls`=0 and `zero_yield_tool_calls`=0** (blind
  instrumentation, confirmed by two auditors).
- **`already_read` refusal is char-count-based, not coverage-based** — refused
  a read while a real 1,000-char hole (EMP doc-2 [38000,39000]) stayed unread.
- **D2: index arm alone had `MIKE_DEEPSEEK_MAX_TOKENS=65536`** (control 32768)
  — uncontrolled second delta (inert in the index direction; possible control
  truncation unverified since deepseek reports no per-round usage).
- **D4: `unique_source_exposure_ratio` mixes planes** (markdown numerator /
  plaintext denominator): two shipped runs report ratios > 1 (1.021, 1.017).
- **D10: judge = single sample per criterion, no temperature control on
  `claude -p`; re-judging clobbers `scores.json` in place** — judge-only
  variance has never been measured and can't be without a scores.<k>.json fix.

### Corrected conclusions

1. **"Efficiency thesis CONFIRMED" above is WRONG as stated.** Cache-adjusted
   input was better only on CoC (−15% vs r2; −24% vs e2e); WORSE on HSR
   (+11.5%) and EMP (+32%). And D3: the HSR "worse" is a round-count artifact —
   uncached input was LESS for the index arm; the gap is 0.1× re-sends across
   24 vs 5 rounds. `cache_adjusted_input` conflates context volume with turn
   count and rides on provider cache-hit rates that ranged 3.6%→83.6%
   uncontrolled across seven runs. Split `uncached_input_tokens` +
   `provider_round_count` before any further efficiency claim.
2. **"Quality neutral within noise" is WRONG in direction, unprovable in
   magnitude.** The index arm is the lowest-scoring arm on both multi-arm
   tasks; its miss-sets are strictly nested inside every other arm's
   (monotone under-coverage signature); 4 criteria are failed uniquely by the
   index arm while 3–4 independent arms pass them. But no single contrast
   reaches p<.05 at n=1 (pooled McNemar p≈0.002 is pseudo-replication —
   criteria within a task share one read-strategy choice), and within-arm
   variance ≥ between-arm gap (the two CoC controls: 5 vs 52 tool calls, 100%
   vs 17% exposure, same arm). Per-run score SD ≈ 2.4+ criteria.
3. **All misses are synthesis, none are read-gaps — now proven on EMP too**
   (7/7 index-only misses had evidence verbatim inside actual exposure
   windows, verified byte-for-byte against beaver-receipts evidence_segments).
   Failure signature everywhere: topic present, required detail absent —
   compression, not blindness.
4. **The real confound is answer length.** Index deliverables are ~half-size
   (CoC 3,533 words vs 6,150–8,151; HSR monotone length→score across all 4
   arms; output/score concordance τ≈0.68). The judge is a pure recall counter
   (binary PASS per criterion, no length penalty). The prompt says "read only
   what the deliverable requires" (well — it *would* have, see D1) and nothing
   about write-side completeness; lean_batch (best-ever 59/65) is the only arm
   carrying an explicit completeness clause.
5. **Price was never measured.** All USD fields are null for deepseek
   (`gpt56ApiRates` prices only -sol/-terra/-luna). Output tokens are never
   cache-discounted; at any output:input price ratio ≥ 2 the index arm is the
   cheapest arm on every task with the best criteria-per-cost. The ledger's
   input-centric framing measured the wrong quantity in both directions.
6. **Upstream control was the wrong comparator** (four deltas). The only
   honest contrast is e2e vs index: CoC 51→47, HSR 47→44 (both n.s. at n=1);
   EMP e2e is unscored → EMP's −6 has no valid comparator.

### Agreed next wave (pending Eli's go; Claude runner+judge, cap opus-4-8, flat-rate)

1. Fix wave: wire+fingerprint the arm prompt (D1), address-aware scoped gate +
   per-doc anchor metrics (D7), head over body plane not served plane (D8),
   zero-length/past-end instrumentation (D5/D6), coverage-based already_read,
   split uncached/round-count metrics + served-plane exposure denominator
   (D3/D4), equalize max-tokens (D2), scores.<k>.json re-judge.
2. Judge-noise floor: re-judge existing runs k=5 (flat-rate) → per-criterion
   flip rate, majority-verdict de-noising.
3. THE experiment: 2×2 read-scope × write-discipline (scoped-index vs whole-e2e
   × current prompt vs +completeness-floor clause), fixed task panel, ≥2
   replicates/cell, paired per-criterion stats, `deliverable_chars` recorded,
   cost C = uncached + 0.1·cached + r·output reported at r∈{1,2,4,6}.
4. Then: H1/H2 deterministic omission audit as a live judged arm (built, never
   run — the determinism branch of the goal).
5. Killed: per-doc sub-agent (#27, forfeits cached prefix), salience-ranked
   index (twice-negative), batching #31 deferred (attacks the 0.1×-discounted
   term; ≤5% expected).

## FIX WAVE A1-A6 LANDED (2026-08-05, Fable) — plan "beat whole-read on 200K consumer windows"

Plan approved by Eli (plans/iridescent-puzzling-church.md). Commits, pathspec-staged:

- `28741fa6` A1: index-arm prompt wired at runtime (chat.ts STRUCTURE_INDEX
  branch) + conformance asserts receipt system_prompt_sha256 against
  sha256(armExpectedSurface(arm).prompt + inventory). Sha reproduction
  verified against 2 real receipts before wiring the gate.
- `360836ae` A2: body-plane reads — head/tail slice the body below the
  SECT-INDEX; new index=true scoped mode (orientation-only); address-aware
  scoped gates (indexIsAddressable: >=5 anchors AND >=25%), per-doc fetch
  gating; interval-coverage already_read. Probe on 4 corpora: memos/
  playbooks/low-anchor redlines now read free; 77-100%-anchored agreements
  gate. Delta bumped to derived-section-index-orient-first-v2.
- `76e54625` A3: exposure metrics — zero-length guard before exposed-doc
  add; served-body-plane denominator (ratio <= 1 by construction).
- `248e864e` A4: claude-p contextRounds receipts; provider_round_count;
  deliverable_chars (+ per-deliverable text_chars).
- `e14b83b8` A5: flatRateLane exempts claude-p from tier/cache receipt gates
  (they killed every prior claude-p run); index arm's 65536 max-tokens
  delta removed; typed ClaudePFatalError context_overflow / quota_exhausted
  (no retries) recorded into run-state.json — context_overflow on a no-fit
  task is a MEASURED OUTCOME.
- `207ab5a7` A6: run_eval --judge-samples K (scores.k*.json, no clobber
  without --force), aggregate_judgments.py majority + flip telemetry,
  deliverable match_method in scores.json. Env hygiene already handled by
  utils/claude_cli.py (post-billing-leak).
- `d00f2f1e` Phase C arms: mike_markdown_e2e_floor_v1 /
  mike_markdown_e2e_index_floor_v1 — LEAN_BATCH completeness clause verbatim,
  ONE delta vs parents; full conformance + delta wiring; both preflight with
  distinct shas.
- `1b4ecebb` lab-compare.ts: per-criterion majority McNemar per task +
  pooled, C = uncached + 0.1*cached + r*output at r in {1,2,4,6},
  deliverable-length confound. Reproduces the audit's HSR e2e-vs-index
  contrast (b=1/c=4, p=0.375).

**LANE EVENT: deepseek adapter is DEAD — 402 Insufficient Balance**
(2026-08-05, closing-checklist smoke). Phase C replicates cannot run on
deepseek until the account is topped up; claude-p:claude-sonnet-4-6 is the
live alternative (unblocked by A5) and matches the flat-rate directive.

In flight: claude-p sonnet smoke of the corrected index arm
(closing-checklist) — exercises A1/A2/A4/A5 end-to-end; k=5 sonnet judge
probe on the EMP index run (Phase B noise floor).

### Protocol amendment (Eli, 2026-08-05, same day)

- **Deepseek retired by design** — the 402 was the intended end state. All
  arm runs move to claude-p (sonnet-4-6 workhorse, opus-4-8 headline).
- **k-fold judging dropped**: the k=5 EMP probe was stopped mid-flight. Judge
  each run once (claude-code/claude-sonnet-4-6); spend the saved quota on
  TASK DIVERSITY instead. Variance discipline = don't over-read small deltas
  + read-gap-vs-synthesis separation, not majority verdicts. A6 machinery
  stays available but is not the protocol.
- Phase C reshaped: 4 arms x 10 fit-band tasks x n=1 on sonnet-4-6, single
  judge pass, decided by per-task McNemar + cross-task sign test
  (lab-compare.ts).

### INCIDENT + IN-VIVO RECEIPTS: scoped-reread wiring gap (2026-08-06)

**Incident.** The first final-arm CoC re-pilot (run 17-31-54) completed all
provider rounds and was then rejected by the A1 prompt-sha gate: c709ba6b
applied the scoped-reread clause swap only to the arm CONSTANT (via a
module-private wrapper), while chat.ts composes the served prompt from env
flags and never swapped the clause. Cost: one full CoC run of sonnet quota;
the gate did exactly what it was built for, but post-run. Fix `59d271ca`:
the swap is now an option of withLabTreatmentPromptAdditions (the single
helper both sides call), gated on MIKE_SCOPED_REREAD with a scoped_reread
receipt field (treatment true, frozen family false). New probe
`.tmp-probe-served-prompt-sha.ts` boots the REAL app with the arm env,
forces a free provider failure after benchmark_surface emission, and proves
served sha == sha256(constant + inventory) — 7/7, now a hard launch gate at
the head of the Phase D sweep script. Rule captured in the helper docstring:
every prompt-editing mechanism MUST be an option of the helper, never a
one-sided wrapper.

**In-vivo mechanism receipts** (the burned run had all four tool-side
mechanisms live; prompt was pre-swap, so its quality is not attributable —
mechanism behavior is):
- Orientation: ONE fetch_documents(index:true) over all 19 docs = 77,619
  chars (~19.4k tok) vs 126,717 pre-compaction on the same task —
  **compact headings −38.7% in vivo** (probe predicted −37%).
- Navigation: 26 scoped read_document windows (86,705 chars) at
  @N-consistent offsets; 3 non-addressable docs whole-served (135,912
  chars) through the attach gate, incl. one explicit "(no SECT-INDEX …)"
  note; 2 memo head-reads (48,889 chars).
- find_in_document: 1 call, literal hit; fold and nearest-match never
  needed (no emphasis-bearing query issued). typed_range never triggered.
- Total tool payload 354,871 chars (~88.7k tok) and drafting completed
  (62,048-char markdown at iter6 structural salvage) — the scoped economy
  holds with the full mechanism stack on.

---

## ADVERSARIAL GENERALIZATION AUDIT + ANCHOR ORACLE + PHASE D GATE (2026-08-06)

### Phase D gate cleared
Fixed-wiring re-pilot `2026-08-06T18-06-18` (all 11 receipt flags incl. `scoped_reread`,
served sha `62b9ec24…`): judged once (sonnet) **50/57** vs hybrid 51/57 and deepseek
whole-read reference 51/57 — at **324.6k input** (hybrid: 662.3k), 5 rounds (hybrid: 9),
19/19 docs, deliverable 75,684 chars. All 7 misses synthesis-tier (severity-rating calls,
aggregate-exposure rollup), zero read-gaps. Threshold ≥49 → row-3 sweep launched
(4 no-fit tasks, MAXJOBS=2, served-sha preflight passed).

### Adversarial audit (opus subagent) — digest + dispositions
15 findings. Corrections from artifacts outside its visibility: treatment arm HAS judged
quality rows (hybrid 51/57, re-pilot 50/57 — its "only judged index run = 47/57" was the
pre-treatment arm); treatment reads 19/19 docs (10/19 was index_v1); ask_inputs drop is
deliberate LAB-surface design. Accepted code defects → task #54 (post-sweep, frozen arms
never hot-edited): (1) `servedDraftingText` drops computed `warnings[]` (tracked-changes
accepted view, text-box exclusion); (2) 300k `MAX_DRAFTING_MD_CHARS` throw is swallowed by
`catch(()=>null)` → silent plaintext whole-read on the largest instruments; (3) missing
pandoc misreported as "malformed XML"; (4) latent whole-read-budget bug: scoped
fetch_documents charges FULL doc length if `MIKE_WHOLE_READ_MAX_CHARS` ever enabled;
(5) find_in_document `index` (ordinal) vs read_document `index` (mode) naming collision.
Couldn't break: body-plane coordinate discipline, conservative anchoring (absence over
guess), attach-gate direction/granularity, interval-union already_read, prompt-sha gate,
typed refusals.

### Anchor oracle — targeted pass, five Phase D corpora (n=91 docs)
Probe: `.tmp-anchor-oracle-corpus.ts` (deterministic; full-corpus pass running separately).
- **Extraction**: 1 over_300k_cap = the antitrust market-data report — the known
  "~84k-token fallback whole-read" caveat's mechanism is the cap throw. 1 no_structure
  (offering-memorandum-excerpts). 88/91 docs carry dropped-warnings (benign classes:
  headers/footers/page-breaks/merged-tables) + exactly ONE tracked-changes doc:
  `precedent-indenture-markup.docx`, served accepted-view with no marker, LIVE in the
  running indenture cell.
- **Addressability**: 71/89 pass the real gate. 10 zero-anchor docs are ALL non-contract
  genres (memos, summaries, term sheets, UCC search results, financial statements) —
  attach gate behaving as designed, NOT auto-numbering. **VERDICT: bare auto-numbering
  does not trigger on the benchmark surface → `resolveDocxNumbering` wiring deferred to
  the production layer (Eli 2026-08-06).** Fraction-floor veto set = 4 docs (13–19
  anchors, 96–117 entries, 14–20%) — the gate-shape critique is real but small here;
  corpus-wide count pending.
- **Anchor correctness** (n=5,484 anchors): outOfBounds 0. notLineStart 1,768 is an
  ORACLE ARTIFACT (anchors point at the first real token after `**`/`<u>` formatting —
  refine the check, not the anchors). Real defect classes: nonMonotone 59 + dup 12
  (~1.3%) and a genuine wrong-(a)/(b) subsection mis-anchor class inside contentMismatch
  156 — e.g. apex-msa `4.4(a)` → a termination `(a)`; great-lakes `1.1(a)` → revolving
  credit `(a)`; pinnacle-credit `1.01(b)` → mandatory-prepayment `(b)`. Wrong window
  under right label at ~1–3% of anchors, concentrated in deep credit-agreement shapes.
  Hardening candidate (#50/#51 family): accept a subsection anchor only when the heading
  fragment confirms within ~200 chars of the token; else emit the line unanchored
  (honesty doctrine). Deterministic-grammar change → the oracle is the corpus instrument.
- **Orientation cost**: mean 4,143 chars/doc compact (in-vivo CoC: 4,085), compact
  saving 28.6% corpus-wide. Extrapolation: 50 docs ≈ 52k tok, 100 docs ≈ 104k tok →
  index-everything orientation dies ~50–100 docs; triage cascade required beyond that.
  Indenture task = 81k index chars over 10 docs (markup precedent alone 37k, 571 entries).

### Eli directives (2026-08-06)
- Coverage-disclosure prompt mechanisms: REJECTED — model honest enough as-is.
- #54 serving-boundary batch: approved, post-sweep.
- **Flagship generalization workstream = needle-in-haystack completeness**: the benchmark
  makes read-most/all correct by construction; the real-world question is completeness of
  findings when most available docs are irrelevant. Design (task #56): distractor-salted
  matters — salt existing tasks with M docs from other tasks' matters (provenance =
  near-free relevance labels); measure quality invariance at M∈{0,10,50,150}, reading
  precision/recall via existing exposure machinery, cost curve f(M), 200K overflow point.
  Salt tiers: cross-practice (easy) / same-practice (hard) / near-duplicate-wrong-version
  (adversarial, interacts with native dup-suppression). Salt manifests seeded + pinned;
  prompts stay mechanism-only (no "beware distractors" hint).
- Requirements-echo must be re-scoped for real multi-turn conversations (what does
  fetch_requirements serve when "the task" is a conversation, not a one-shot?) — task #57.
- Upstream's 10-round cap is NOT sacred — ablation candidate (task #57). The scoped arm's
  batching economy is shaped by the cap; more/smaller rounds may suit it better.

### Production index-exposure design (Eli question, same day — tracked as task #57)
Framing directive: this and all similar threads are about a real viable product, not a
benchmark MVP. Exposure tiers: (1) user-selected/displayed docs → push the full
SECT-INDEX with the selection event, no tool call; (2) matter/project scope → push a
SHALLOW triage inventory for every doc (~1–2 lines: type/title/size/top-level count,
~150 chars/doc — scales to hundreds) inside AVAILABLE DOCUMENTS; full indexes are NOT
pushed (mean 4.1k chars/doc → 100 docs ≈ 104k tok); (3) full index arrives FUSED with
first touch — read_document on an untouched doc returns index + requested window in ONE
result, so index-then-read is never a mandatory two-step; bare index:true and batched
cross-doc orientation remain optional patterns (in vivo the batched orientation round
paid for itself: one round, −50% input); (4) library scale → search-first, nothing
pushed. Cache economics: the shallow inventory sits in the stable cached prefix; fused
indexes cache from their first tool result onward. Staleness: recompute on doc version
change (deterministic). UI dividend: the same SECT-INDEX powers a sidebar TOC. Indexes
respect read ACLs (headings are content). Measurement: fused vs two-step ablation
(rounds/latency/tokens); the #56 salting design stresses the triage layer directly.

### Sweep rows 1-2 judged + the coverage-accounting defect (2026-08-06, same day)
- **antitrust-risk-assessment: 75/95** (sonnet judge, judged once). 5 rounds, 464.0k in /
  49.2k out, 12/12 docs exposed (ratio 0.62), 4 deliverables 81.1k chars. Misses are
  synthesis/specific-fact tier (HHI arithmetic, filing-fee figure, SSNIP framing,
  divestiture-remedy trio). The over-300k-cap market-data report (plaintext fallback
  whole-read) did not sink the run.
- **acquisition-due-diligence: 30/64** — the arm's worst quality row, and the diagnosis
  is exact. 31 sources; documents_read_directly=29 (touches incl. index-only) but body
  exposure only 19 (unique_source_exposure_ratio 0.177); fetch_requirements echo counted
  TOUCHES, reported "2 unread" — 12 docs had served nothing but headings and the
  coverage organ was blind to them. The 12 unexposed docs map ~1:1 onto the failed
  clusters: zenith supply agreement → C-024..27 (all four Zenith criteria);
  ip-assignment compilation → C-014..16; bylaws + certificate of incorporation →
  C-004..07 quorum + C-031..32 consent; calloway → C-037..38; meridian-properties →
  C-008; san-marcos → C-057. Rounds 8-10 were UNUSED and round 5 nearly empty — false
  assurance, not budget exhaustion. Residual misses on touched docs (Pinnacle loan
  terms, Orion UCC-1 inside the read lien-search) are the shallow-window class (#51).
- **Disposition**: task #49 rescoped to the coverage-accounting fix (echo lists count
  body exposure; index-only touches reported separately as "oriented only"; optional
  typed generate_docx nudge) — flag-gated, post-sweep, frozen family asserts false.
  This row is ALSO the first in-corpus measurement of the needle-in-haystack
  completeness cliff (#56): at 31 sources the read-rationing failed silently. The echo
  organ's own accounting was the proximate cause; the salting design must measure
  coverage on the exposure plane, never the touch plane.

### Sweep close-out: tax confirms the exposure cliff; indenture infra failure; the exposure-accounting fix lands (2026-08-06 late)

**Tax judged 39/77 (51%)** — the second mass-failure row, same disease as
acq and worse: touches 25/25, body exposure 11/25 (`unique_source_exposure_ratio`
0.0824, the lowest measured), echo reported **0 unread**, 6 rounds used with
budget headroom, one 40k-char memo. Failed criteria cluster by ISSUE
(Netherlands substance, India markup, Mexico maquiladora, QCSA buy-in,
Singapore treasury, Japan deadlines) exactly like acq's unexposed-doc→failed-
cluster mapping. Quality now tracks exposure across all four judged Phase D
rows: CoC 19/19 exposed → 50/57; antitrust 12/12 → 75/95; acq 19/31 → 30/64;
tax 11/25 → 39/77. The completeness cliff is doc-count-driven and
coverage-accounting-mediated, measured twice.

**Indenture cell failed on infra, not the arm**: the model completed a valid
126KB TOOL_CALLS envelope batching BOTH required indenture deliverables, then
hallucinated the harness reply (`{"tool_results":...}` with a fabricated CDN
URL + citations block) after its own calls; first-{..last-} spanned the
concatenation and no repair path parses that. Fixed in claudeP.ts
(2b8d4642): string-aware balanced-prefix scan recovers the first complete
object, accepted only on strict parse + shape, so truncation and
dominant-string classes keep their paths; probed against the real bad reply
(both calls recovered) + regressions. Also runs before the truncation
refusal on purpose: a cap hit inside the hallucinated continuation leaves a
complete, usable envelope. Indenture re-running on frozen v1 (cell stays
comparable with its sweep siblings).

**Judge-lane incident**: claude.exe auto-updated mid-judging (npm shim
replaced the 280MB binary at 14:42); spawns hit a half-written PE and died
as WinError 216 / silent exit-1. Settled on its own; 6/6 spawn probe passed;
tax judged on the third attempt at --parallel 2. Also noted: judge.py:303
surfaces only stderr while `--output-format json` errors land on stdout —
fold into any future judge-harness pass.

**Exposure-accounting fix (task #49) implemented and committed (388a2d82)**,
flag `MIKE_EXPOSURE_ECHO`, new arm `mike_markdown_e2e_index_treatment_v2` =
frozen v1 env + the flag, same prompt + tool list (payload-only mechanism):

- `splitReadExposure()` classifies allowed docs read / oriented_only /
  unread on the delivered-intervals plane (`bodyExposedChars` > 0 past
  `bodyStart`); find_in_document hits deliberately do NOT count as exposure
  (candidates, not coverage).
- fetch_requirements payload: `documents_read` = body-exposed only, new
  `documents_oriented_only` bucket + one explanatory note sentence;
  `documents_unread` stays "never touched" in both modes so the receipt
  field keeps one meaning. First-echo receipt gains
  `documents_oriented_only_at_echo`.
- Authoring boundary: FIRST generate_docx refuses once (`coverage_check:`)
  naming unexposed docs; second call always proceeds — one-shot,
  loop-proof, relevance authority stays with the model.
- Conformance asserts `exposure_echo` per arm (v2 true, frozen family
  false-asserted); fingerprint gains `exposure-echo-v1` +
  `markdown-e2e-index-treatment-v2` deltas in all three clusters.
- Proof: 15/15 behavior checks in both flag states (frozen payload
  byte-identical, oriented bucket + gate correct); served-sha probe passes
  in v1 AND v2 modes incl. frozen-floor historical-receipt equality.

**In flight**: indenture re-run (v1, parser fixed) + acq-diligence re-pilot
on v2 — the direct test of whether honest coverage accounting flips the
15–18 unexposed-cluster criteria from the 30/64 row. Serving-boundary batch
(#54) queued next as its own commit series.

### Indenture 67/83 completes the treatment matrix; serving-boundary batch lands; the drafting cap is gone (2026-08-06)

**Indenture re-run (parser fixed, frozen v1) judged 67/83 (81%)** —
13/14 docs exposed, both deliverables (110,615 chars), 5 rounds, 342k
logical input, 13 min, clean generation (no salvage needed this time; the
hallucinated-continuation defect is stochastic and now covered). Misses are
synthesis-tier (TIA §310(b) machinery, IRC §956 flexibility, after-acquired
property, continuing-directors) — not read-gaps.

**Phase D treatment matrix complete (5/5 rows, sonnet-4-6, one judge each):**

| task | docs exposed | score | verdict |
|---|---|---|---|
| CoC | 19/19 | 50/57 (88%) | healthy |
| antitrust | 12/12 | 75/95 (79%) | healthy |
| indenture | 13/14 | 67/83 (81%) | healthy |
| acq-diligence | 19/31 | 30/64 (47%) | exposure cliff |
| tax | 11/25 | 39/77 (51%) | exposure cliff |

Exposure and quality separate perfectly. Every completed row fits the 200K
window mechanically; quality at doc-count scale is coverage-mediated —
which the v2 exposure-accounting arm targets (acq re-pilot in flight).

**Serving-boundary batch (#54) landed (84dbfebf):**
- **The 300k drafting cap is REMOVED, not raised** — Eli: "not one that is
  random and artificial." It was token policy at the extraction layer whose
  swallowed throw silently swapped docs onto the plaintext whole-read plane
  (costing MORE than the markdown it refused). Memory stays bounded by the
  real package guards (input bytes, entry count, per-entry + total inflated
  XML ceilings). The market-data report now extracts (351,405 chars, 3.3s)
  with an addressable 5,429-char SECT-INDEX → future antitrust-shaped runs
  read it scoped instead of an ~84k-token fallback whole-read. Principle
  recorded in memory: bounds derive from real constraints; token policy
  lives at the serving layer.
- pandoc-missing ENOENT passes through honestly (no longer "malformed XML");
  real conversion failures keep naming the part (test-pinned).
- Whole-read budget projects on the served plane (markdown drafting surface
  when present), not plaintext (latent until MIKE_WHOLE_READ_MAX_CHARS is
  ever enabled).
- `MIKE_SERVE_CONVERSION_NOTES` (OFF everywhere; production/v3 candidate):
  extraction warnings ride the FIRST read as a CONVERSION NOTES line at the
  citation-reminder layer — served-plane coordinates untouched. Proven on
  the real warnings-bearing doc, both flag states.
- **Deferred to the production layer**: find_in_document `index` (ordinal)
  vs read_document `index` (mode) rename — a tool-schema change cannot ride
  v1/v2, whose tool sha must stay equal; same deferral class as the
  numbering resolver.

Proof chain: docx conformance 20/20, structureIndex + localToolWiring
39/39, exposure probe 15/15 both states, notes probe both states, tsc
clean, tax/indenture judged once each.

### Tax miss autopsy: the model skipped the PRIMARY INSTRUMENTS (2026-08-06)

Doc-level mining of the tax 39/77 row sharpens the exposure-cliff story:
the 11 exposed docs are the ANALYSES (benchmarking studies, restructuring
memo, substance report, financial statements, audit summaries, master
file); the 14 unexposed are almost all the OPERATIVE AGREEMENTS — both IP
licenses (Germany, Japan), the US→NL→Germany sublicense, the QCSA
agreement, both Singapore loan agreements + NL→Germany loan, the guarantee
fee agreement, toll + contract manufacturing agreements, IT/engineering and
management/shared services agreements, and the engagement letter.

~26–28 of the 38 failed criteria require exactly those skipped instruments
(German royalty vs refined IQR → Germany license; QCSA buy-in/participants
→ QCSA agreement; Singapore thin-cap/negative spread → loan agreements;
India markup inconsistency → India services agreement; conduit concern →
sublicense; stale allocation keys → Germany management-services agreement;
engagement-letter conflict → the letter). The rest: shallow windows on
exposed docs (Mexico criteria despite the maquiladora doc read) + a few
pure-synthesis misses.

Failure shape: for a TP documentation-review task the issues live in
AGREEMENT-vs-BENCHMARK comparisons; the model read the benchmark side only,
and the touch-based echo ("0 unread") ratified the skip. Selection bias
worth naming for #56/#57: name-based salience steered reads toward
analysis-sounding titles and away from boilerplate-sounding contracts —
in production, doc-TYPE priors (operative instrument vs commentary) may
deserve a place in the shallow triage inventory. Tax re-pilot on
mike_markdown_e2e_index_treatment_v2 launched (parallel with the acq v2
re-pilot): the coverage_check will name all 14 skipped instruments at the
authoring boundary.

### Full anchor-oracle sweep: 11,293 docs (2026-08-06, task #53 complete)

Per-doc rows in `backend/.tmp-anchor-oracle-report.tsv`. Headlines:

**Extraction (n=11,293):** ok 10,929 (96.8%), no_structure 355, extract
errors 9 — and ALL NINE are `over_300k_cap`, i.e. today's cap removal
(84dbfebf) fixes every extraction error in the corpus. 11,277 docs carried
dropped warnings[] (the pre-fix population), including **294 docs served as
the accepted view of tracked changes** — the conversion-notes flag has a
real corpus-wide population, not a corner case.

**Addressability (n=10,929 with an index):** gateBoth 8,392 pass (77%),
zero-anchor 1,485 (13.6%, the non-contract genres), fraction-floor vetoes
276 — the veto list is dominated by exactly the deep finance shapes
(credit/intercreditor agreements, term sheets, REDLINES/markups at 6–19%
anchored). Redline-heavy docs under-anchor systematically → ties to the
mike-redline port plan and #50 extent work.

**Anchor oracle (463,958 anchors):** `outOfBounds = 0` corpus-wide — the
bounds invariant holds at scale. notLineStart 63,422 (13.7%) is the known
oracle artifact (first-real-token after `**`/`<u>`). Real defect classes:
nonMonotone 2.9%, dupAnchor 0.6%, contentMismatch ~0.95% across 3,134
docs — same wrong-(a)/(b) subsection class as the targeted pass (plus an
arabic-vs-roman `[ARTICLE 1]` => "article i" label class). The
confirm-within-200-chars hardening candidate (#50) now has corpus-wide
incidence numbers.

**Orientation cost:** mean 3,122 chars/doc compact (17.1% saving); 50 docs
≈ 39k tok, 100 ≈ 78k tok, 150 ≈ 117k tok of index alone — confirms
index-everything dies before 100 docs and the triage-tier design (#57).
Single-doc outliers: foreign constitutions/articles at 40–71k index chars
(1,118 entries).

**THE DISCOVERY — native haystack corpora exist in-repo:** the diligence/*
tasks are full data rooms: enterprise-software-diversification **2,319
docs** (6.9M index chars), cybersecurity-tuck-in 2,276, gaming-strategic-
acquisition 1,979, aerospace-vertical-integration 1,674. The #56
needle-in-haystack workstream does not need synthetic salting to start —
four native 1,600–2,300-doc matters are on disk. Salting stays useful for
controlled M-sweeps, but the first completeness-at-scale measurements can
run on real data-room structure (folder taxonomy included).

### acq v2 judged 26/64 — forced exposure BACKFIRED (2026-08-06, the Goodhart row)

Mechanism fired perfectly; quality fell. Paired v1↔v2 criterion diff:
**fail→pass: 1** (Orion UCC-1, a find-level fact). **pass→fail: 5**
(Axelion uncapped indemnity + its Radiance linkage, R&D credit
quantification, shareholder-consent-for-CoC, Holloway equity
acceleration) — all on docs v1 HAD read deeply. The v1 unexposed-doc
clusters (Zenith, IP assignments, bylaws quorum, Calloway)**still failed
in v2 even though v2 read those docs** — they were crammed in the last two
rounds after the coverage_check refusal and contributed ~nothing.
Deliverable SHRANK 68,481 → 61,667 chars while reading breadth rose 63%
(19→31 docs; input 462k→620k).

Verdict: **exposure was a correlate, not the cause.** Cells where the
model organically read everything also integrated everything; FORCING
exposure at the authoring boundary produces compliance reads, not
integration, and dilutes depth on the docs that were carrying the score.
The binding constraint on the cliff tasks is cross-doc SYNTHESIS budget
(quorum ← bylaws×minutes; consent ← certificate×loan×deal-structure), not
document coverage. A late gate is the wrong place for a coverage signal;
if it matters at all it must shape the READING PLAN at orientation time,
not trigger a cram at drafting time.

Dispositions:
- The honest-echo INSTRUMENT stays (true lists beat false ones; it is
  also how we measure). The authoring-boundary GATE is presumptively
  wrong — do not carry it into any v3 without a redesign that moves the
  signal early.
- Tax v2 (in flight when this judged) is now a genuine replication test
  of the negative result. Registered prediction: exposure ≈ 25/25, score
  ≈ flat-or-down vs 39/77. Judge once when it lands.
- The live hypothesis for the NEXT arm is evidence-driven selection, not
  coverage forcing: the treatment arm's only search is per-doc
  find_in_document (literal Ctrl+F, no regex, no multi-doc). A coding
  agent greps the corpus and reads hits. Grep machinery already exists
  in-repo (lean_batch Grep+Read, mike_grep_v1, upstream project Grep,
  working-set Grep) — compose a treatment-chassis + corpus-grep arm and
  A/B it (native-tool-shapes hypothesis; also the only plausible shape at
  diligence scale, where per-doc find across 2,300 docs is hopeless).

### Tax v2 replication + the coding_markdown_v1 build (2026-08-06 evening)

**Tax v2 judged 42/77** (v1 39/77): +10/−7 paired. The gains ARE the
previously-skipped agreements paying off on identification criteria (India
markup + amend-recommendation, conduit concern, QCSA participants ×2,
tangible goods, Form 3CEB deadline); the losses are again depth/synthesis
(UK dual character ×2, prioritization ×2, guarantee-fee assessment,
Netherlands quantification). **Pooled v2 vs v1 across both cliff tasks: 68
vs 69 of 141 — exposure forcing is quality-NEUTRAL at +30–50% input, with
heavy churn.** Identification-on-skipped-sources gains are real but paid
for by depth losses under a fixed synthesis budget. Verdict stands:
selection, not coverage pressure, is the live lever.

**coding_markdown_v1 built and verified (cdb8063f)** — Eli's pure-coding
directive: name and shape the tools exactly like the coding toolset the
models were RL'd on; don't reinvent. Composition: the frozen lean-batch
chassis verbatim (executors, tool list, p0-pure-coding descriptions) with
two attributable deltas — (1) the coding executors honor
MIKE_READ_DOCX_MARKDOWN and serve the pandoc-markdown plane through the
shared per-turn drafting cache (grep hit at file:line → Read offset=line
returns the same line, proven on the real Zenith agreement; Glob reports
markdown chars; frozen lean-batch stays byte-on-plaintext), and (2) a
navigation-neutral prompt (MIKE_CODING_NEUTRAL_PROMPT) that REMOVES the
SOURCE WORK prescriptions per Eli — run 1 observes native pathway
selection; only write-side discipline remains (grounding/clean reads, one
completeness check, terminal authoring, filename-in-prose). Read contract
inherited from lean-batch: paths[] = batch whole-read; offset/limit with
one path = bounded line window. Conformance asserts both flags per arm
across the lean family; deltas coding-markdown-v1 + coding-neutral-
prompt-v1 in all three fingerprint clusters; served-surface probe (sha +
flags + no-prescription assert) green in coding mode with treatment-mode
regression intact.

Pilot design (pending go): one observational run on acq-diligence (the
30/64 baseline; also where selection bias was measured) on claude-p
sonnet-4-6 effort high; judge once; mine the trajectory for pathway
choices (grep-first? batch-read? bounded windows?) BEFORE any guidance is
added.

### Adversarial audit of coding_markdown_v1 (opus subagent, 2026-08-06 late)

Full report in-conversation; 16 attacked-and-held non-findings (frozen-arm
isolation, grep↔read coordinate consistency incl. index-attached case,
glob translation, cat-n parity, claude-p no-collision via --tools "",
exposure denominator plane). Ranked findings:

**Structural**: the arm serves LEAN-BATCH's real tools, not CC's — no
Glob (hard-refused if called; the CC-trained opening move burns a round),
Read is paths[] batch (unbounded = UNNUMBERED whole-doc blobs via
fetch_documents; bounded = cat-n) — two output formats behind one name,
neither the file_path prior. The near-verbatim CC Read description
(CODING_READ_DESCRIPTION) exists in-repo as DEAD CODE on the unserved
CODING_SHAPE_TOOLS branch.

**S1 measurement**: (F1) list_documents emits per-doc opening-line
evidence segments → documents_read/exposed SATURATE for the whole lean
family — the pathway-observation metric of the observational arm is dead;
(F2) the inventory reports PLAINTEXT chars/lines while Read/Grep operate
on markdown — measured 1.24–1.75× line divergence; a model sizing a
"complete" read off the inventory under-reads by up to 43%.

**S2 prior-misleading**: (F5) JS RegExp u-flag rejects ripgrep-legal
patterns (\-, \%, escaped space, POSIX classes) — table measured; (F6)
-A/-B/-o/multiline/type silently IGNORED (a -A:5 call returns bare lines,
model concludes no continuation), default output_mode content vs CC's
files_with_matches, undocumented; (F7) provider-materialized minima:
offset=1&limit=1 → silent one-line "read"; batch+offset → refusal.

**F8 fail-closed gaps — FIXED (b2e6b7db)**: child env now resets all
treatment/serving flags ahead of per-arm spread; lean-family conformance
gains the prompt-sha gate + six mechanism false-asserts.

**Axis 3 (prompt-layer efficiency parity)**: our served descriptions
carry NONE of CC's efficiency cues (no "read only the part you need", no
stated defaults, no search-before-read steer) — removing SOURCE WORK left
LESS efficiency signal than the trained environment has. Worse: the ONE
navigation signal remaining is the Read description's "returns every
requested document completely in one batch" — an anti-native whole-read
invitation. The arm as-built is navigation-BIASED toward whole reads,
against the hypothesis under test.

**Adjacent pre-existing hazard**: find_in_document gates its plane on
STRUCTURE_INDEX, not MARKDOWN_READ_DOCX → in five frozen markdown-read
arms (e2e, treatment v1/v2, floor, read-upstream-draft) find searches and
excerpts PLAINTEXT while read_document serves markdown — quotes drawn
from a plane the model was never shown. Disposition needed (fold into
#51).

**Plan**: pilot (in flight) observes the as-built surface — interpret
with the whole-read-bias caveat. Then coding_markdown_v2 = the parity
pack per Eli's function-identical directive: serve Glob; single CC-shaped
Read (file_path, always cat-n); CC-cue descriptions (new arm-gated
constants — frozen schemas have byte-equality tests); regex fallback
(retry sans u-flag); -A/-B honored; minima guard; inventory on the served
plane; exposure metrics exclude inventory/candidate segments.

### coding_markdown_v2 — the CC parity pack lands same-day (2026-08-06 night)

Per Eli ("let's not defer any work that we know is coming"), every audit
finding that shapes the pure-coding experiment is wired in (8b61d8a6),
one flag (MIKE_CODING_PARITY), frozen lean surfaces byte-untouched:

- **Surface**: v2 serves Glob / Grep / Read / generate_docx — the CC
  shapes. Read is single-file file_path, ALWAYS cat -n, 2000-line
  default, and carries CC's own efficiency cue ("when you already know
  which part you need, pass offset and limit"). Grep defaults to
  files_with_matches like the trained environment, honors -A/-B, and
  documents its modes. The lean paths[] batch Read — and its anti-native
  "returns every requested document completely in one batch" invitation
  — is gone from this arm. list_documents is not served (the system
  prompt's AVAILABLE DOCUMENTS block already names the corpus), which
  also removes the inventory-segment exposure saturation at the source.
- **Executor parity** (flag-gated): ripgrep-legal patterns the JS u-flag
  rejects retry without unicode strictness; -A/-B per-side context in
  both grep render loops; provider-materialized {offset:1, limit:1}
  minima read the default window (mirrors the section-mode guard).
- **Metrics (all arms, future runs)**: kind=candidate segments (grep and
  find hits, inventory opening lines) no longer count toward
  documents_read/exposure — the audit's F1/F10 saturation; they surface
  as documents_candidate_only + candidate_span_chars. Pre-fix and
  post-fix documents_read are not comparable; noted here once.
- **Harness**: route surface-drift guard expects the swapped list; F8
  fail-closed env + lean prompt-sha gate landed separately (b2e6b7db).

Proofs: plane probe md/plain/parity green (files_with_matches default,
-A context rows rg-style, u-flag fallback match, minima guard reads 369
lines); served-surface probe v2 6/6 + v1 5/5 + treatment 9/9;
localToolWiring byte-equality + structureIndex 39/39; tsc clean.

Open: v1 observational pilot still in flight (its Read schema is the
lean paths[] one — pathway observations read against that surface); v2
pilot on the same task follows for the paired comparison. F2 (inventory
plane) is moot for v2 and deferred with the lean+markdown-no-parity
combination it belongs to. find_in_document plaintext-plane hazard in
five frozen arms remains filed under #51.

## v1 PILOT POST-MORTEM + AUTO-COMPACT DISCOVERY + AUTHORING PARITY (2026-08-06, Fable)

coding_markdown_v1 acq-diligence pilot (claude-p sonnet-4-6 effort
high, launched 15:45, killed 16:44, session
ab9c3192-94e3-4402-8148-3b461143aa55.jsonl in the backend project dir —
runner wrote no transcript because the run never terminated; the
session file is the record). Three findings, each bigger than the run:

- **Navigation: the coding surface elicited whole-read, not search.**
  Rounds 1–5 (five minutes): ten batch Read paths[] calls covering all
  31 docs (~981KB served), a tidy category sweep — corporate → equity/
  employment → financials/IP → litigation/contracts → licenses/
  insurance. Zero Grep. Zero Glob. Zero bounded reads. Audit caveat
  applies: v1's lean Read description advertises the batch ("returns
  every requested document completely in one batch") and carried no
  efficiency cues, so this reads as invitation-following, not free
  preference. v2 (CC descriptions, search-before-read steers, no batch
  invitation) is the real test of the pure-coding navigation
  hypothesis.
- **claude -p AUTO-COMPACTED TWICE, silently** (system/compact_boundary
  events 21:51:58 preTokens=207,948 and 22:08:57 preTokens=179,180;
  durations 234s/377s). The whole-read blew the 200K window and the CLI
  summarized the conversation in place — twice — so everything after
  22:09 drafted from a summary-of-a-summary of the documents. The
  runner saw nothing. Consequences: (1) the Phase D whole-read control
  rows will NOT produce typed context_overflow on this transport —
  growth-past-wall compacts instead of erroring (the 200K-wall memory
  describes single-oversized-prompt refusal, a different path); (2) any
  arm that overflows mid-run silently degrades instead of failing.
  Detection now wired end-to-end (Eli: detect first, no autocompact
  pinning yet): claudeP parses compact_boundary (real-fixture probed,
  snake_case covered), receipts ride StreamChatResult.compactions with
  triggerReason "provider_auto" and zeroed usage (spend already in turn
  envelopes), manifest passes through, runner surfaces top-level
  context_compaction_count/context_compactions + loud warn. System
  events now count as watchdog liveness (compaction 2 ran 377s, past
  the 240s inactivity kill — healthy sessions were killable
  mid-compaction before).
- **The CC Write prior captured the authoring tool.** At 22:02 the
  model drafted the full memo (83KB) and called generate_docx with
  {filename, content} — Claude Code's Write shape — despite the served
  {title, markdown} schema. Ten straight rejections: full redrafts
  decaying 83→70→66→36KB, then a genuinely rational minimal-repro probe
  cascade (title+content; markdown alone; "Hello") that the CONJUNCTIVE
  validator defeated — every single-key change failed identically, so
  the model concluded "the parameter name isn't the issue" and started
  hallucinating a 'template' param. The terse refusal ("DOCX title or
  Markdown is invalid") named the fields but not the contract. Rounds
  are unbounded on every non-native arm (chat.ts maxIterations
  undefined), so nothing would have ended the loop before context
  exhaustion — and with auto-compact, not even that cleanly.

Fixes (commit 08385015, all CODING_PARITY-gated, frozen arms
byte-identical): executor accepts 'content' as the body and derives
'title' from filename/first heading, success receipt carries a
schema-teaching note; refusal states the full expected contract plus
received keys (typed-refusals doctrine: typed AND actionable);
CODING_GENERATE_DOCX_TOOL description names its keys in prose against
the Write prior ("this is not a file Write") — CC's own
efficiency-cue-in-description pattern, same name and schema. Proofs:
compaction fixtures 7/7; plane probe parity 12/12 (alias ok + note,
straight ok no note, refusal actionable), md 5/5 (v1 keeps the frozen
terse refusal), plain 3/3; served-surface coding2/coding/v2 green;
suites 57/57; tsc clean.

Verdict on v1: the observational question is answered and the arm is
retired — its Read schema invites the exact pathology under test.
Design lesson for #57: conjunctive validators + terse refusals turn
model debugging into anti-learning; every refusal must state the full
contract. Smoke next: coding_markdown_v2 on capital-markets/
compare-closing-documents-against-closing-checklist (34.5k tok,
fits without compaction) to validate the wired surface end-to-end
before the paired acq pilot.

## v2 SMOKE + TAX PILOT + COMPACTION GUARD + v3 SECTION-CONTEXT (2026-08-06 evening, Fable)

**Smoke (closing-checklist, 34.5k, run 2026-08-06T22-58-45): 29/32.**
8 Reads + generate_docx straight {title, markdown} (the description cue
worked; alias untriggered), context_compaction_count=0, candidate
metrics live, 44k in / 17k out / 2 rounds. Misses: one synthesis depth
(tax opinion's guarantor-payment omission unflagged) + two severity
calibrations (Critical where the rubric wanted Significant). Zero
read-gaps (8/8 docs).

**Tax pilot (draft-transfer-pricing-documentation, 292k corpus, run
2026-08-06T23-06-43): completed with ONE auto-compaction — the
detection chain worked live end-to-end** (transport warn at iteration
6, preTokens 167,683; runner warn; context_compaction_count=1 with a
provider_auto receipt in metrics). Pathways: 17 Reads, ZERO Grep —
second surface, second task, same verdict: models do not spontaneously
search these corpora; they read documents whole even under CC
descriptions with search-before-read steers. 12/25 docs read. The
autopsy oracle answered in part: v2 DID reach three of the six
operative instruments the treatment arm skipped (engagement letter —
read early — QCSA agreement, guarantee-fee agreement) but IP licenses,
loan agreements, and manufacturing/services agreements stayed unread.
Micro-finding: the first three Read calls used "doc-N: filename"
verbatim from the AVAILABLE DOCUMENTS block as file_path (wrong shape,
self-corrected) — inventory-line format vs file_path is a small
surface-polish item. 428k input tokens (compaction-inflated), 38k out.
Judge pending (WinError 216 npm auto-update strike two — claude.exe
2.1.223 settled, judge relaunched).

**Compaction runaway guard (Eli directive: "make sure that doesn't
loop forever")**: typed stop at 3 auto-compactions — ClaudePFatalError
"compaction_limit", never retried, classified in run-state. A
real-degradation bound: 1 compaction = tolerable lossiness (tax
completed), 2 = summaries-of-summaries (v1 acq), and nothing else
bounds the cycle (rounds uncapped; each compaction re-opens headroom).

**coding_markdown_v3 (grep section-context) BUILT + verified, one
flag MIKE_GREP_SECTION_CONTEXT over v2**: content-mode grep hits are
preceded by their enclosing SECTION lead as an rg context row at its
real line number — document-true, quotable, Read-able (zenith probe:
`...docx-147-**Section 9.2 — Termination for Cause.**...` above the
:149: hit). Resolver is two-plane (docx detector nodes anchored into
served markdown via anchoredSectionStarts) because the skeleton
compiler finds 0 nodes on pandoc markdown (probed); version-memoized;
subsections excluded; soft degradation for non-docx. v3 Grep
description documents the rows CC-style. Conformance: per-arm
grep_section_context asserts; fail-closed reset gained
MIKE_GREP_SECTION_CONTEXT + the previously missing MIKE_CODING_PARITY.
Proofs: plane sect 14/14 + parity 14/14 (v2 emits no lead rows),
served-surface coding3 7/7 / coding2 7/7 / treatment 9/9, suites
57/57, tsc clean. Commit d33fd14a.

**Standing question for the next move**: two coding-surface runs, zero
Grep calls — v3's annotation only pays if grep happens. The lever list,
in escalation order: (a) v3 as built (annotation makes search results
richer, maybe self-reinforcing once tried), (b) prompt guidance toward
scoped reads (Eli earlier: "we should still instruct it toward clean
reads I think?"), (c) inventory-line sizes (the lean list_documents
carried chars; the coding AVAILABLE DOCUMENTS block does not — a model
that cannot see document sizes cannot budget reads).

## v4 CoC PILOT: 51/57 — EQUAL-BEST THROUGH A 200K WINDOW (2026-08-06 night, Fable)

**coding_markdown_v4 BUILT (commit 4f931f17), one flag
MIKE_CODING_TOC_FILES over v3**: companion `.toc` virtual files
(grep -n convention rows `LINE:verbatim section lead`, one
`# filename — N section leads (chars, lines; Read offset=<line>…)`
header) served through Glob (sizes in-band; `*.toc` filterable) and
Read (cat -n, no evidence recording); plus
CODING_MARKDOWN_BUDGET_LAB_SYSTEM_PROMPT — neutral prompt + CONTEXT
BUDGET block (start with Glob; overflow/lossy-compaction stated as
fact; scoped reads; batch calls per turn) — deliberately
window-agnostic (zero 200K constants) for bigger-model transfer.
Strategy-fix hypothesis after two zero-grep runs: sizes + budget frame
+ search-first cue should engage the CC-trained grep instinct.

**CoC pilot (analyze-change-of-control, 230k corpus / 57 criteria,
run 2026-08-06T23-44-53): 51/57 — ties the all-time best on this task
(deepseek markdown-e2e whole-read, 51/57 @ 145k tok), beats treatment
50/57 and reverse-swap 45/57 — through the 200K claude-p window with
ZERO compactions.** The pathway flipped exactly as hypothesized: Glob
`*.{docx,toc}` → corpus-wide triage grep (files_with_matches) → 2 memo
whole-reads → corpus content grep -A 8 → 14 per-doc clause-harvest
greps → 4 scoped offset reads → straight {title, markdown}
generate_docx. 24 calls in 8 rounds (~3/round batching). 5/19 docs
whole-read + 13 candidate-only (114,800 candidate chars); 469,536 in /
28,271 out; wall 640s.

**The demonstration inside the score: all five FCB Credit Agreement
criteria passed (35% threshold, $23.75M acceleration, $475k
make-whole, Sept-15 notice, mandatory-prepayment-not-consent) with
that document never whole-read** — grep -A 8 windows + v3 section-lead
rows carried criterion-grade detail. Lead rows fired live (10 in the
session stream, e.g. `docx-29-**Section 1.1 — Definitions.**`).
Misses: 5 synthesis/inference-depth (Pinnacle severity ranked below
TerraNode C-009; Apex CoC-leverage-on-nonrenewal connection undrawn
C-019; Orion protective-consent recommendation absent C-021; 280G
named but not developed C-033; NovaBridge IL-enforceability question
unraised C-034) + 1 candidate-only detail miss (C-047, Apex's second
60-day effectiveness period — the run's single read-gap-class miss).
Same miss class as every other arm; the scoped strategy added ~one.

**Sub-finding: the .toc files went unread.** Grep-first made
standalone orientation unnecessary — Glob sizes + the budget frame
chose the strategy; grep -A context + lead rows carried section
orientation inline. The toc's value this run was zero-cost presence
(its Glob rows advertise per-doc size/line counts); whether it pays on
structure-navigation tasks (indenture) stays open.

**Tax v2 judged: 42/77 — ties exposure-v2's equal-best, beats
treatment 39/77** (12/25 docs, 1 compaction, zero grep — the pre-v4
read-everything pathway; kept as the contrast row).

**Next (Eli directive): Opus 5 A/B, one task (CoC), same v4 arm** —
window-agnostic prompt transfers unchanged; pre-flight = slug routing
proof (deepclaude trap) + CLI window measurement (>200K?).

## GEN-3 BATTERY + GEN-4 ECHO STRATUM + TRANSPORT BURST + DRAFT-EDIT LANDS (2026-08-07 pre-dawn, Fable)

**Gen-3 battery (v5 pre-echo, flash runner + flash judge, all 7 tasks,
03:15–03:20 launches): acq 56/64, HSR-antitrust 47/50, tax 45/77, DPA
51/58, employment 54/59, insurance 55/57 — pooled 308/365 (84.4%) —
plus closing 31/32 (claude-sonnet judge, its own stratum; the run_eval
default slipped in; kept, matches the historical claude-judged closing
row).** Every task full doc coverage INCLUDING tax 25/25 — correcting
the earlier belief that tax underread: the 12/25 tax row was v2-era.
The grep-first v5 chassis reads everything it needs unprompted; zero
compactions anywhere.

**Gen-4 = gen-3 + one-shot exposure echo (receipt
`exposure_echo_delta: exposure-echo-v1`), 5 paired rows (03:42–04:30):
acq 57/64, antitrust 49/50, tax 42/77, employment 53/59, insurance
55/57 — pooled 256/307 vs gen-3's 257/307 on the same 5. Dead parity.**
Coverage was already saturated pre-echo, so the echo bought no reads it
needed to buy. Its measured cost is the SECOND EMISSION: output tokens
up on every leg (acq 41.3k→65.4k, antitrust 20.5k→32.3k, tax
39.4k→64.6k, employment 32.9k→41.6k, insurance 23.8k→37.0k); cache-adj
input mixed (acq +210k, antitrust +123k, tax +225k, employment −32k,
insurance −7k). Also visible: redraft compression drift — employment's
deliverable shrank 59.7k→44.3k chars across the echo boundary and its
score dropped a point. Tweak/add/pare input: the echo as pure refusal
is score-neutral and emission-expensive HERE; its insurance value
(catching a genuinely underread run) never got to fire on a chassis
that already reads everything. DPA + closing have NO gen-4 rows —
gen-4 was superseded by gen-5 before they ran; the echo ablation
stands on 5 pairs.

**Transport burst (~03:55–04:30): five deaths in ~35 min** — four
deepseek undici `TypeError: terminated` (acq gen-4 pre-relaunch-fix,
employment ×2, insurance ×1) plus the indenture claude-p leg
(connection-closed → unparseable TOOL_CALLS → 900s watchdog kill,
3-attempt fatal). Machinery landed in response, all committed:
`d972f3e3` zero-progress round retry in deepseek.ts (retries transport
errors only while NO delta has been forwarded — post-emission retry
would duplicate text into the persisted turn; classifier probe 10/10);
`6f65dd42` run-level single relaunch in lab-beaver-arm.ts (parent
re-execs once on transport-class run-state failure, marker env guards
recursion); `093be19d` relaunch strips `--run-id` and mints a fresh
run dir (first live firing tripped main's append-only-evidence guard).
Validated same night: employment and insurance relaunches each
absorbed ANOTHER terminated death and completed. Run-state note:
success paths leave `status: provider_call_pending` — terminal states
are typed-failure-only; completion evidence is metrics.json +
deliverables.

**Indenture on claude-p sonnet-4-6 (v5 arm, Phase-D shakeout): died at
the 200K wall** — auto-compaction twice at preTokens ≈198.8k on
iteration 5, then the parse/transport cascade. Sonnet under v5 read
~190k by round 5 on the 248k-corpus draft task — the grep-first
discipline that holds on flash did not transfer. Relaunched once
(fresh sample); if it dies the same way, that IS the Phase-D row for
this cell: v5-on-sonnet whole-reads itself into compaction-thrash on
the no-fit whale.

**Draft-edit lever (gen-5) BUILT + FLIPPED INTO v5**: echo-refused
generate_docx body persists as `draft.md` in per-turn state; `Edit`
(Claude Code exact semantics: unique match or replace_all, typed
refusals, $-literal splicing) revises it; markdown-less generate_docx
renders the buffer. Taught just-in-time via refusal text + tool
descriptions — NO system-prompt change, so the prompt sha carries
across generations. Commits: `6e841c9e` mechanism flag-off (gen-4
stratum stayed clean), `be06387a` env flip + `draft_edit_delta`
receipts ×3 + conformance (surface.draft_edit per arm; v5 resident
tools gain Edit), `c496e459` chat.ts leak-guard taught the append (the
guard correctly rejected the unregistered 5-tool surface on smoke #1 —
the flag-off construction was why gen-4 never saw it). Probe 7/7 on
applyDraftEdit. Rationale from the grid: coverage is saturated, misses
are output-side synthesis, and the echo's whole cost is re-emission —
draft-edit keeps the echo's refusal insurance while converting
revision from re-emission (~24k/run) into incremental edits, and kills
the compression drift employment exhibited. Gen-5 smoke on employment
in flight; battery (7 tasks incl. DPA/closing) next, then the deep
tweak/add/pare over gen-3/4/5 receipt strata.

## GEN-5 BATTERY COMPLETE: DRAFT PERSISTENCE WINS, EDIT NEVER FIRES (2026-08-07 ~06:30, Fable)

**Full 7-task gen-5 battery (receipt `draft_edit_delta: draft-edit-v1`,
flash runner + flash judge, 05:15–06:07 launches): tax 53/77 (all-time
best, +8 over gen-3 45, +11 over gen-4 42), acq 57/64 (ties best, −27%
out vs gen-4), DPA 52/58 (new best), HSR-antitrust 48/50, insurance
55/57, employment 53/59 — pooled 318/365 (87.1%) vs gen-3 308/365
(84.4%) on the same 6; on the 5 gen-4-paired tasks gen-5 266/307 vs
gen-4 256/307 vs gen-3 257/307. Closing 27/32 under flash stands
UNPAIRED: its only prior row is the claude-sonnet-judged 31/32
(run_eval default slip), and cross-judge comparisons are barred —
verified `lab-compare.ts:190` throws on mixed judges, and the runner
model is pinned by the arm-dir name, so both model confounds are
guarded structurally (Eli 2026-08-07: "Do not allow model confound").**

**The Edit tool went 0-for-7. The lever's measured value is DRAFT
PERSISTENCE, not editing.** Two routes observed: (a) employment only —
argless `generate_docx({})` probe consumed the echo pre-emission, then
read-all + single draft; (b) the other six — full draft → refusal
saves it as draft.md → model serially reads the listed unexposed docs
→ markdown-less render of the UNTOUCHED buffer. Since the render is
byte-identical to the pre-refusal draft, the post-echo reads provably
contribute nothing to the deliverable; the gate is one-shot
(exposureNudgeServed), so those reads are the model's compliance
choice, not a requirement. Cache-adj cost of that ritual vs gen-3:
tax +277k, acq +128k (25/31-doc tasks) — but DPA −158k, HSR −25k,
insurance −43k, employment −22k, i.e. gen-5 is CHEAPER than gen-3 on
every small-doc task while scoring ≥ gen-3 everywhere except
employment −1. Out tokens: single emission everywhere (second `"markdown"`
emission absent; e.g. acq 47.6k out vs gen-4's 65.4k double-emission).

**The causal surprise: drafting EARLY beats drafting late.** Gen-3 tax
also read 25/25 but composed once at the end — 45/77. Gen-5 composed
mid-research from grep-scoped evidence, the buffer preserved it
verbatim across 25 subsequent reads, and that early draft scored
53/77. Gen-4's re-emission path scored 42/77 with compression drift.
So the score gains ride on early composition + verbatim persistence;
the echo-forced late reads are pure input spend. Tweak decided
(gen-6, `draft-edit-v2` receipt): reword ONLY the refusal/draft notes
— unread list becomes "verify selectively: grep/skim for anything
that contradicts or adds to your draft," Edit named as the
incorporation path, rendering without further reads stays legitimate.
Targets the tax/acq waste while keeping what wins. Delta battery on
tax/acq/HSR next.

**Sonnet lane killed by order mid-battery** (Eli: "no more sonnet.
stop that now"): the indenture v5-on-sonnet relaunch was process-tree
killed; its `2026-08-07T05-05-06` dir stays as a killed artifact,
never judged, never in any grid. Phase-D's sonnet-shakeout step is
dead; any future claude-p leg is opus-4-8 only and only on Eli's
explicit ask.

## FALSE-REFUSAL DISCOVERY + COMPOSITION-COVERAGE LENS + v3/v4 REFINEMENT ARC (2026-08-07 ~07:00, Fable)

**CORRECTION of the previous entry's causal claim.** "Drafting early
beats drafting late" was a call-index artifact. The draft-timing table
over all 21 judged runs (first bodied generate_docx position + distinct
docs Read before it, from raw SSE) shows the real variable is EVIDENCE
COVERAGE AT COMPOSITION: tax scored 96%-coverage 53 (g5), 92% w/
re-emission 42 (g4), 64% + 2 edits 48 (v3 r1), 48% 45 (g3). Only tax
varies below 100% — every other task self-achieves full coverage before
drafting, which is why its scores barely move across generations.

**BUG: every echo firing in the coding family was a FALSE refusal.**
The coding-shape Read never wrote `turnReadState` — the state
`splitReadExposure` consults at the generate_docx gate
(`runCodingShapeCall` had no such parameter; the one recording site in
the file was the mike-shape readOne). The gate always saw an empty map
and refused the first bodied draft with an ALL-documents "never opened"
list: verified tax g5 listed 25/25 with 24 actually read, acq v3 listed
31/31 with 31 read. The model believed the list and serially re-read
everything — the true source of tax +277k / acq +128k cacheadj. The
echo never once measured coverage on this chassis; gen-4's "parity" and
gen-5's routes all rode a fabricated refusal. Fix (`ada6e7c8`): the
four coding Read success paths record served spans as merged intervals
(body-only plane, bodyStart 0); Grep hits and .toc reads stay
non-exposure by doctrine. Receipt `exposure-echo-v2`. Gen-7 smoke
(employment 06-45-38, echo-v2 + draft-edit-v3): honest gate stayed
SILENT at full coverage — single emission, zero ceremony, cacheadj
67.5k = cheapest employment row of the night (g3 121.8k, g4 89.6k, g5
99.5k).

**Draft-edit-v3 wave (refinement-forward note; Eli's loop: draft →
keep → selective reads → precise edits → render).** v2's
"render-without-reads-is-fine" tail was killed before any judged row
(3 part-run dirs are killed artifacts; receipt bumped v2→v3 so killed
receipts never alias live bytes — `c19dafdb` superseded by
`8e962c58`). v3 results, all flash: acq 58/64 then 60/64 — BOTH above
the 56-57 ceiling of gens 3-5, second sample also cheapest (513.8k
cacheadj); tax 48/77 + 51/77 (above g3 45/g4 42, below g5's
96%-coverage 53); HSR 48/50 (ceiling band). Edits went 2/2/2/2/4, all
ok:true, all substantive — including a genuine numerical correction
(tax balance-sheet reconciliation figures) discovered by post-draft
verification. Verdict: edits add +1..+3 ON TOP of full-coverage
drafts; they cannot substitute for coverage at composition (both v3
tax deliverables thin: 43.4k/38.9k chars vs g5's 50.1k).

**draft-edit-v4 (`bc57d942`): universal refinement checkpoint.** The
honest gate interacts destructively with v3: acq's refinement gains
existed only because the FALSE refusal captured the draft at full
coverage — an honest shortfall-only gate never pauses those runs, so
the checkpoint (and the +1..+3) silently vanishes. v4 decouples
capture from coverage: the first bodied generate_docx always pauses
once — draft saved as draft.md, coverage reported honestly (true
unread list when short; "all N documents served" when complete),
refinement note (Grep/scoped-Read selectively, fold findings in with
Edit, render markdown-less) — and the next call renders. Echo-only
arms keep pure shortfall-refusal semantics. Argless probes at full
coverage fall through to the typed invalid-input refusal (no empty
render path). Gen-7 stratum = (exposure-echo-v2, draft-edit-v4);
battery starting tax + acq (the discriminating tasks), then the rest.

## GEN-7 RESULTS + FULL-DAY STRATA GRID + v5_echo DISPOSITION (2026-08-07 ~07:45, Fable)

**Gen-7 rows (echo-v2 + draft-edit-v4, flash runner + flash judge).**
- acq 06-52-15: **60/64** — ties the all-time best. `refine_check`
  route (full coverage honestly reported), 2 Edits, ZERO re-reads,
  cleanest trace of the family; 577.4k cacheadj, largest acq
  deliverable (101.7k chars).
- employment 07-07-07: **57/59** — identical to the 06-45-38
  no-ceremony smoke (echo-v2 + edit-v3, also 57/59). The universal
  checkpoint is score-neutral where the draft is already complete;
  its cost was +16.8k cacheadj (84.3k vs 67.5k) for 2 Edits.
- HSR 07-07-09: **48/50** — ceiling band (47-49 across all strata);
  Grep + 5 Edits post-checkpoint.
- tax 06-52-13: **38/77** n=1 — the honest `coverage_check` listed the
  TRUE 9 unread docs; the model read exactly those 9, made 3 Edits —
  mechanically perfect, yet 18 deep-synthesis criteria flipped down vs
  g5's 53. Composition-coverage law: the flips live in what was
  composed before the checkpoint, and tax judge noise is ±5 → rep2
  required before 38 stands (in flight).

**Full-day strata grid** (all 2026-08-07, score @ cacheadj; flash
judge throughout except closing g3, which is sonnet-judged and
excluded from cross-gen pools):

| task | g3 no-echo | g4 echo-v1 | g5 +edit-v1 | v3 edit-v3 | g7 echo-v2+edit-v4 |
|---|---|---|---|---|---|
| acq | 56 @438k | 57 @648k | 57 @566k | 58 @637k, 60 @514k | **60** @577k |
| tax | 45 @454k | 42 @679k | 53 @731k | 48 @980k, 51 @780k | 38 @620k (rep2 out) |
| employment | 54 @122k | 53 @90k | 53 @99k | 57 @68k (echo-v2) | **57** @84k |
| HSR | 47 @185k | 49 @307k | 48 @160k | 48 @158k | 48 @169k |
| insurance | 55 @184k | 55 @177k | 55 @141k | — | queued |
| DPA | 51 @324k | — | 52 @167k | — | in flight |
| closing | (31/32 sonnet) | — | 27/32 @99k | — | queued |

**Employment is the cleanest honest-echo signal.** Its only rows ≥57
all-time are the two echo-v2 rows with draft-edit enabled. The
false-echo rows (g4 53, g5 53) sit BELOW the no-echo g3 (54): on this
small n, the fabricated ceremony cost ~1-4 criteria while the honest
checkpoint added +3 over baseline. On acq the same shape: an honest
v3 gate would never have paused (full coverage → silent), so g7's 60
vs g4/g5's 57 IS the checkpoint's marginal contribution under honesty.

**v5_echo (T2) disposition.** Three 03:20 runs (HSR/acq/tax) —
the echo-only arm, v5 chassis + exposure-echo-v1, no draft
persistence (config predates the draft-edit flag) — completed under
the false-refusal echo and sat unjudged. First-judging them now
(flash) as gen-4-stratum replicates. Their cacheadj vs same-wave
triage twins isolates pure false-ceremony cost when there is no draft
to save: HSR 431.9k vs 184.7k, acq 602.7k vs 438.6k, tax 710.4k vs
454.0k — roughly +37-134% input burn for the fabricated unread list
alone. A VALID T2 (honest echo-only) needs fresh runs post-ada6e7c8;
whether to spend that is a #59 analysis call.
RESULT (flash-judged ~07:55): HSR **49/50** (ties g4's all-time HSR
best — echo-v1 rows are the two best HSR rows), acq **58/64** (above
the 57 plateau, below the checkpoint 60s), tax **41/77** (replicates
g4's 42 — the false-echo re-read + re-emission harm on tax is now
n=2: no-echo 45 → false-echo 42/41; draft persistence rescued it to
53). Echo-v1 stratum n=2 on all three tasks; scores sit within noise
of their triage twins everywhere except tax, at +37-134% cost.

**CRITERIA-FLIP ANATOMY (named flips over finalized pairs).** What
the checkpoint actually buys, and what it cannot:
- acq g5(57)→g7(60): **+3/-0, all three UPs are cross-doc LINKAGE
  criteria** — C-015 "links missing IP assignments to pending patent
  applications", C-032 "connects shareholder consent issue to board
  quorum deficiency", C-033 "shareholder consent needed for
  change-of-control" — exactly the two Edits that run made (CoC +
  IP-indemnification). The +3 is causally traceable to the
  refinement loop: its value is connective tissue between documents.
- employment g5(53)→g7(57): +5/-1 — concrete identifications (bonus
  75→100, cure 30→45, Good Reason trigger, Sponsor cash ceiling) +
  the exec-summary apparatus (C-053); vs g3 also C-054 summary
  table. Recurring loss: C-012 (profits-interest $0-cost-basis
  ambiguity) — held in g3 AND g5, lost in g7.
- tax g5(53)→g7(38): **+3/-18; the 18 DOWNs are quantification/
  deep-synthesis criteria** (DEMPE analysis, India markup exposure
  quantified, German adjustment quantified, NL spread ~$1.1M, QCSA
  buy-in, PCT methodology, financing arm's-length, allocation-key
  analysis...) while the 3 UPs are identifications (NL substance,
  Singapore risks, BEPS refs). A ~3-edit refinement pass cannot
  inject 18 quantifications missing from the composed draft —
  the composition-coverage law, now visible criterion-by-criterion.
- HSR g4(49)→g7(48): -1, noise-grade (an enforcement-posture note).

Analysis consequence for #59: keep the checkpoint (cheap; buys
linkage criteria at full coverage), and treat tax as a DIFFERENT
problem — the lever there must put the quantitative cores of all 25
docs into context BEFORE composition (the no-fit synthesis
question), not refine after it.

**Lane state.** The 07:07-07:16 3-wide wave (tax rep2, DPA,
insurance) was externally killed — dead run-state-only dirs, never
judged, never in any grid. Resumed 2-wide per the
less-parallelism directive: tax rep2 + DPA gen-7 in flight,
insurance + closing gen-7 queued behind them.

## GEN-7 BREADTH VALIDATION BATTERY (design, 2026-08-07 afternoon, Fable)

**Eli's direction:** no tax-specific attack unless a simple idea
generalizes; the spend goes to validating the fixed shape (echo-v2 +
draft-edit-v4, arm `coding_markdown_v5`, flash runner + flash judge,
judge-once) over a BROADER task set, with re-runs only where n=1
leaves real ambiguity. Panel results so far: DPA gen-7 **51/58**
(plateau band 51-52 — checkpoint score-neutral again); insurance +
closing gen-7 and tax rep2 judgment in flight; acq gen-7 rep2 queued
(the +3-linkage claim rests on one row).

**Breadth set — 12 tasks, 11 new practice areas, chosen from the
489-task launchpad census for verb/size/doc-count spread** (docx
bytes as size rank; the 4 `diligence` data-room tasks at 2.8k-3.6k
docs are a different weight class, excluded):
1. real-estate/extract-psa-key-terms/scenario-01 — extract, 3d, 75c
2. banking-finance/extract-credit-agreement-covenants — extract, 3d, 65c
3. banking-finance/compare-credit-agreement-against-term-sheet — compare, 3d, 33c
4. arbitration.../analyze-counterparty-markup-of-arbitration-agreement — markup, 5d, 69c
5. data-privacy.../audit-privacy-policy-compliance/scenario-01 — audit, 5d, 50c
6. international-trade-sanctions/compare-entity-details-against-ofac-sanctions-list — screening compare, 5d, 53c
7. corporate-governance/analyze-eu-ai-act-high — regulatory gap, 7d, 66c
8. bankruptcy.../compare-plan-treatment-across-creditor-classes — compare, 8d, 61c
9. intellectual-property/analyze-restrictive-covenant-enforceability-across-multiple-jurisdictions — cross-doc analysis, 13d, 59c
10. funds-asset-management/analyze-fund-economics-comparison — QUANTITATIVE stress, 14d, 106c (does the tax-class quantitative-synthesis collapse generalize, or was tax special?)
11. litigation-dispute-resolution/build-litigation-case-timeline — many-doc synthesis, 15d, 66c
12. energy-natural-resources/analyze-counterparty-markup-of-credit-agreement — LARGEST corpus stress, 12d, 83c

**Tax gen-7 rep2 landed (16-13-27): 48/77.** The 38 was a LOW DRAW.
Gen-7 tax = {38, 48} (mean 43), inside the v3 band {48, 51}; same
route both reps (true coverage_check list → read exactly those docs
→ 3-5 Edits → render). Consequences: (1) tax judge spread at FIXED
treatment is ~10 criteria, not ±5 — no per-row tax delta under 10 is
interpretable, only strata means; (2) the "-18 quantification flips"
anatomy was partly judge draw, not all mechanism; (3) the
composition-coverage cap STANDS (every post-g5 row sits below the
96%-coverage 53) but the checkpoint-collapse narrative is retired.

**Validation read-out per run** (mechanism scorecard, not just
score): checkpoint route (`refine_check` vs `coverage_check` and
whether the unread list is TRUE), edit count + ok:true +
substantiveness, re-read behavior after the checkpoint, single final
render, no compaction/window failure on the flash lane, cacheadj.
Scores stand alone (no baselines exist on these tasks) — breadth
validates the MECHANISM and surfaces task-genre failure modes;
superiority claims stay on the 7-task panel where strata exist.
Execution 2-wide, judge-as-they-land.

## GEN-7 BREADTH BATTERY — results landing + cost columns + queue expansion (2026-08-07 late, Fable)

**Token-cost reporting ON** (Eli directive): every run row carries
`score @ cacheadj | out | uncached | cache_read` from metrics.json
(uncached = first-touch input, cache_read = re-read hits; cacheadj =
uncached + 0.1·cached, the price-weighted proxy). Grid columns go
to: score / cacheadj / out-tok / uncached-in. No data-room job is
queued (Eli retracted the 1-data-room ask; the 4 diligence tasks
stay excluded at 2.8k-3.6k docs).

**Panel rows landed:**
- closing gen-7 (16-25-21): **30/32** @70.5k | 31.5k out | 36.6k uncached | 339k cache_read. Up from g5 27/32@99k — higher score AND cheaper. (g3 31/32 sonnet-excluded.)
- insurance gen-7 (16-21-47): **55/57** @119.4k | 32.8k out | 69.9k uncached | 495k cache_read. Column closed FLAT: g3 55 / g4 55 / g5 55 / g7 55 — the fixed shape neither gains nor loses on insurance; insurance is saturated at 55/57 regardless of echo/edit treatment.
- acq gen-7 rep2 (16-27-36, checkpoint route: 34 reads -> 5 greps -> draft -> 2 Edits -> render): 47.4k out | 245k uncached | 3.43M cache_read | **588.4k cacheadj** — judge in flight.

**Queue expansion (Eli directive — CORRECTED 2026-08-07 late: "more baseline" = more UPSTREAM MIKE NATIVE baseline runs, `mike_upstream_native_v1`, NOT e2e):**
the faithful OG-mike control (read_document/find_in_document, no
markdown, no progressive disclosure) paired onto the breadth cells
where whole-read fits 200K. Fit-band (census tok): real-estate 13.8k,
banking-extract 13.8k, banking-compare 14.0k, arbitration 21.5k,
privacy-audit 27.1k, trade-sanctions 25.2k, eu-ai-act 37.4k,
bankruptcy 49.4k → all 8 get a paired `mike_upstream_native_v1`
control. The 4 largest (IP 559KB, funds 570KB, litigation 576KB,
energy 726KB) are no-fit (whole-read would overflow 200K) → lean-only,
matching the phase-D overflow logic. One `mike_markdown_e2e_v1`
real-estate row was launched before this correction and is kept
LABELED as an e2e whole-read row (a control-shaped datapoint, not the
native control; the native control still runs on real-estate).

- acq gen-7 rep2 (16-27-36) judged: **59/64** @588.4k | 47.4k out | 245k uncached. Gen-7 acq = {60, 59} mean 59.5 — the +3-linkage claim now rests on n=2 and STANDS; rep1's 60 was not a lucky draw. (Strata: g5 57@566k, v3 {58,60}, g7 {60,59}, T2 58.)
- real-estate breadth-1 LEAN (16-35-34): checkpoint route clean (7 reads -> draft -> 2 greps + 3 Edits -> render), 25.6k out — judge in flight. Whole-read baseline (16-39-25) in flight for the pair.

- real-estate breadth-1 LEAN judged: **67/75** @78.0k | 25.6k out | 44.4k uncached | 335k cache_read | 3/3 docs | checkpoint route (7 reads -> draft -> 2 greps + 3 Edits -> render). Standalone score, no strata on this task — mechanism row only. Paired NATIVE control + the accidental e2e row pending.

- real-estate e2e row (16-39-25, accidental pre-correction launch, KEPT AS LABELED): **3 whole-read tool calls** (list/fetch/generate), 21.7k out, 33.1k cacheadj, 3/3 docs. Not the control — control-shaped whole-read datapoint only. Native control on real-estate in flight (first native-on-flash run).

- banking-extract breadth-2 LEAN (16-40-10) judged: **60/65** @124.5k | 43.8k out | 54.8k uncached | 697k cache_read | 3/3 docs. Standalone mechanism row (no strata on this task); 3-extract-covenants genre behaves like the panel's extract rows.

- arbitration breadth-4 LEAN (16-51-59) judged: **66/69** @69.5k | 54.8k out | 27.8k uncached | 416.5k cache_read | 5/5 docs. Markup-of-counterparty genre — 5-doc markup completes at 95.7% criteria on a lean plane (27.8k uncached, the least first-touch input of the battery so far).

- eu-ai-act breadth-7 LEAN (17-06-56) judged: **63/66** @149.9k | 28.6k out | 81.1k uncached | 687k cache_read | 7/7 docs. First 7-doc regulatory-gap cell — 95.5% criteria at 81k first-touch input. Mechanism held at the largest dev-legal doc count. BREADTH READ-OUT: the fixed shape (echo-v2 + draft-edit-v4, lean plane) holds in the 89-96% band across FIVE genres (real-estate extract 67/75, banking extract 60/65, arbitration markup 66/69, eu-ai regulatory gap 63/66, closing 30/32, insurance 55/57) — the tax quantitative-synthesis collapse (48/77, 62%) stands alone as the genre outlier, consistent with the "tax quantification criteria" finding, not a shape failure.

- **real-estate NATIVE control on flash (17-16-11) judged: 67/75** @152.2k cacheadj | 82.6k out | 92.8k uncached | 593k cache_read | 3/3 docs | 8 tool calls (fetch_documents -> 6x generate_docx -> read_document), receipts None/None. **FIRST PAIRED NATIVE-VS-LEAN RESULT ON FLASH: TIES the lean row (67/75 @78.0k) — lean is ~2.1x cheaper on first-touch input (44.4k vs 92.8k) and ~1.95x cheaper on cacheadj at identical criteria.** SPEED AXIS: lean wall 237s (4.0min) vs native 528s (8.8min) — lean is ~2.2x FASTER. Mechanism: native emits 3.2x more output tokens (82.6k vs 25.6k; long reasoning + whole-read drafting + repeated generate_docx) even though its per-second output rate is higher (156 vs 108 out/s); more tokens at a higher rate still = 2.2x longer wall. The native arm is now drivable on flash: the cap fix (MIKE_DEEPSEEK_MAX_TOKENS=65536, committed f1d04857) — the 16-42-55 failure ("authored 0/1") was the 32768 per-response budget consumed ENTIRELY by reasoning_content at reasoning max (trace: 32,866 reasoning_delta events, empty content_final); raising the budget let the model emit tool calls. Reasoning effort stays max for parity with the treatment arm. Native controls are now available for the remaining fit-band battery cells.

- **NATIVE CONTROL ON FLASH — FAILED (16-42-55, real-estate):** `mike_upstream_native_v1` on deepseek-v4-flash made ZERO tool calls after one fetch_documents and streamed plain text; harness gate hard-refused ("authored 0/1 required DOCX deliverables"). flash cannot drive the faithful OG-mike native arm. All existing native runs are claude-p-sonnet lane. The paired native control is UNAVAILABLE on flash; native-vs-lean comparisons must either use the existing claude-p-sonnet native rows (cross-lane, confounded by runner model) or wait for an explicit opus-4-8 claude-p ask (per memory: claude-p = opus-4-8 only on explicit ask).**

**Weight-sensitivity caveat (standing, appended 2026-08-07):** all cacheadj columns above use weight 0.1 (uncached + 0.1·cache_read), the harness-stored value = OpenAI GPT-5.x / Anthropic cache discount (90% off). deepseek-v4-flash's TRUE cache weight is 0.02 (50×, official pricing $0.0028/$0.14/M), so deepseek-lane cost comparisons using these 0.1 columns overstate cache-heavy runs up to ~5×; gen-7-vs-g3 cost ratios @0.02/0.1/0.5 computed in the chat table (acq 1.03/1.33/1.75, tax 0.95/1.18/1.45, emp 0.48/0.69/1.71, HSR 0.66/0.91/1.82, ins 0.44/0.65/1.66, DPA 0.29/0.48/1.20 — g7 cheaper 5/6 @0.02, 4/6 @0.1, 0/6 @0.5). The "better AND cheaper" story is deepseek-cache-discount-specific; under luna (0.1) gen-7 is roughly cost-neutral on average, cost-positive on acq/tax.

## RUN RESULT — mike_upstream_native_v1 DEEPSEEK-V4-FLASH BASELINE BATCH (2026-08-07, runner)

Backlog fill for the UPSTREAM MIKE CONTROL lane: the faithful OG-mike arm
(`mike_upstream_native_v1`, read_document/find_in_document, no markdown, no
progressive disclosure, MIKE_DEEPSEEK_MAX_TOKENS=65536) run on the
deepseek-v4-flash lane across the dev-tier backlog, judged ONCE per run by
deepseek-v4-flash (explicit `--judge-model`; no default-sonnet judging).
Paired treatment rows are `beaver-coding_markdown_v5-deepseek-v4-flash` where
a row for that task exists. Run dir base:
`benchmarks/harvey-labs/results/<task>/beaver-mike_upstream_native_v1-deepseek-v4-flash/<ts>`.

| task | score | judge | tokens (in/out) | docs | wall | run dir (ts) |
|---|---|---|---|---|---|---|
| antitrust-competition/analyze-antitrust-hsr-strategy | **44/50** | deepseek-v4-flash | 436,814 (—/65,791) | 9/9 | 495s | 2026-08-07T17-45-36 |
| arbitration-international-dispute-resolution/analyze-counterparty-markup-of-arbitration-agreement | **64/69** | deepseek-v4-flash | 177,408 (140,817/36,591) | 5/5 | 316s | 2026-08-07T17-45-41 |
| banking-finance/extract-credit-agreement-covenants | **55/65** | deepseek-v4-flash | 258,410 (214,503/43,907) | 3/3 | 369s | 2026-08-07T17-56-17 |
| capital-markets/compare-closing-documents-against-closing-checklist | **29/32** | deepseek-v4-flash | 218,736 (176,821/41,915) | 8/8 | 329s | 2026-08-07T18-01-14 |
| corporate-governance/analyze-eu-ai-act-high | **64/66** | deepseek-v4-flash | 403,802 (368,715/35,087) | 7/7 | 274s | 2026-08-07T18-06-06 |
| corporate-ma/draft-acquisition-due-diligence | **53/64** | deepseek-v4-flash | 794,641 (754,030/40,611) | 31/31 | 415s | 2026-08-07T18-07-54 |
| insurance/analyze-property-damage-claim-against-commercial-policy-exclusions | **54/57** | deepseek-v4-flash | 389,784 (353,003/36,781) | 7/7 | 306s | 2026-08-07T18-15-08 |
| tax/draft-transfer-pricing-documentation | **40/77** | deepseek-v4-flash | 1,280,347 (1,225,947/54,400) | 25/25 | 476s | 2026-08-07T18-20-30 |
| white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement | **43/58** | deepseek-v4-flash | 282,377 (255,087/27,290) | 6/6 | 247s | 2026-08-07T18-28-40 |
| antitrust-competition/compare-expert-market-share-estimates-against-agency-data | **53/56** | deepseek-v4-flash | 322,154 (281,704/40,450) | 6/6 | 282s | 2026-08-07T18-38-52 |
| antitrust-competition/analyze-counterparty-markup-of-protective-order | **43/49** | deepseek-v4-flash | 238,346 (202,468/35,878) | 6/6 | 358s | 2026-08-07T18-45-55 |
| antitrust-competition/prepare-antitrust-risk-assessment | **36/95** | deepseek-v4-flash | 355,475 (295,499/59,976) | 25/25 | 553s | 2026-08-07T18-45-55 |

**Failure → recovered (harness gate, not a score):** capital-markets/compare-closing-documents-against-closing-checklist
first attempt (17-56-20) authored 0/1 DOCX — the model made one `fetch_documents`
call then answered in plain text (4,742 chars) without calling `generate_docx`;
harness gate hard-refused (ARM_EXIT=1). Judge artifacts were removed (a false
0/32 would have polluted compare.py's `rglob("scores.json")`); the attempt is
preserved as raw-sse.txt + run-state.json. Same failure signature as the 16-42-55
real-estate attempt (native-on-flash can decline to emit generate_docx); unlike
16-42-55 this was NOT an output-budget exhaustion — the budget fix (65536) held,
the model just chose text over the tool. **RE-RUN (18-01-14) SUCCEEDED: 29/32**
(90.6%) — the model emitted `generate_docx` on retry (tool sequence
fetch_documents -> generate_docx -> read_document, 4035 answer chars, 8/8 docs).
Treating the first attempt as a stochastic native-on-flash refusal, not a
task-specific blocker.

**BLOCKED — task-specific native-on-flash harness refusals (employment-labor markup):**
employment-labor/analyze-counterparty-markup-of-executive-employment-agreement
failed the DOCX gate on ALL THREE attempts (18-11-08 authored **0/1** after
~8 min text answer; 18-19-45 authored **3/1** over-produced; 18-30-57 authored
**0/1** again). Harness gate ARM_EXIT=1 at lab-beaver-arm.ts:2882 each time;
no judge artifacts (clean, no compare.py pollution). The model cannot reliably
emit exactly one DOCX on this task's corpus on flash — flag as a task-specific
blocker: **no native baseline available on flash for this cell.** (Contrast
capital-closing, which recovered 0/1 -> 29/32 on attempt 2.) The paired
treatment row exists; this native cell is left as a known-missing control.

**First-attempt refusal (18-33-00, stochastic) -> RECOVERED:**
antitrust-competition/analyze-counterparty-markup-of-protective-order authored
0/1 DOCX on first attempt (harness gate ARM_EXIT=1, no judge artifacts, clean).
**Re-run (18-45-55) SUCCEEDED: 43/49** — recovered on retry, capital-closing
precedent confirmed (2nd stochastic-refusal task to recover on attempt 2).

## CORRECTION (2026-08-07 late, Fable): DRAFT-EDIT WAS SHADOWED THROUGH ALL GEN-7 — EDIT CALLS NEVER APPLIED

**Finding:** the in-memory draft-edit handler (`localAssistantTools.ts:8254`) was
dead from day one. The lever commit `6e841c9e` added the handler but never
touched the `CODING_TOOL_SHAPE` dispatch above it (`localAssistantTools.ts:8101-8121`),
which returns `runCodingShapeCall(...)` for every Edit. `runCodingShapeCall`
resolves paths against the filesystem; `draft.md` exists only in
`requirementsState.draftMarkdown` (never on disk) — so every
`Edit("draft.md", …)` answered `ok:true` with the 29-char string
`"File does not exist: draft.md"`, and the in-memory handler never received the
call. Trace-proof: `benchmarks/harvey-labs/.tmp/v5-trace.txt` (real-estate
16-35-34) — 3 Edit calls, all `ok=True chars=29`, then `generate_docx` without
markdown rendered the UN-EDITED draft.

**Consequence for every gen-7 row that reports Edits** (acq 2, HSR 5, tax 3,
real-estate 3, employment 2): ALL Edit calls failed. Final renders used the
un-edited saved draft. The breadth-battery validation read-out's "edit count +
ok:true + substantiveness" criterion was systematically **false-positive on the
edit axis** — `ok:true` was the error-string wrapper, not an applied edit.

**Corrected attribution:** any gen-7 gains (acq +3 linkage, employment +4 vs g5,
closing +3 vs g5) are attributable to the echo/refinement CHECKPOINT loop — the
honest coverage/refine pause + re-composition — NOT to applied edits. The acq
"exactly the two Edits that run made… the +3 is causally traceable to the
refinement loop" claim (C-015/C-032/C-033) is wrong in mechanism: the edits
never touched the draft; the +3 is traceable to the checkpoint + re-composition
alone.

**Fix (commit `68cce2b4`, "fix(lab): route Edit by target so draft.md reaches
the in-memory draft"):** one dispatch condition routes Edit by target — for
`DRAFT_EDIT_ENABLED && file_path === "draft.md"`, the call falls through to the
now-reachable in-memory handler; any real path resolves through
`runCodingShapeCall`'s FS text-ops editor exactly as before. Both surfaces kept
(real-document editing + in-memory drafting).

**Deterministic proof:** new regression test in `localAssistantTools.test.ts`
drives the real dispatch end-to-end: bodied `generate_docx` captures the draft →
`Edit("draft.md", old, new)` returns `{ok:true, replacements:1}` and mutates the
buffer → `generate_docx` without markdown renders the EDITED buffer. 48/49 pass
(the 1 failure — "keeps oversized research results" — is pre-existing and
unrelated, confirmed via stash). `tsc --noEmit` clean.

**Post-fix validation:** v5 real-estate scenario-01 smoke (the exact task whose
3 gen-7 Edits all failed) queued — first honest datapoint on whether the edit
lever helps. Open design note (2026-08-07, Eli): the served `Edit` description
still prescribes a single target ("always draft.md"); under discussion is a
dead-simple surface (plain Claude Code semantics over `draft.md` AND source
files, with source-edit events monitored distinctly) so the model never needs
the in-memory backstory and unprompted source-file edits are observable.

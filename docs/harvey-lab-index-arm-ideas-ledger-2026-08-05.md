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

# Composition-checkpoint — treatment hypothesis (2026-08-08)

Status: **REVISED after adversarial audit.** Original hypothesis audited by
subagent `a5f5b8b3608b3f4e3` (2026-08-08) → **REVISE-THEN-BUILD**: the primitive
is real and fires on its own fixture, but the first draft's internal-consistency
chain was electrically broken in 3 of 5 links. This revision corrects every
refuted claim; §0 records the disposition. Not yet built — this doc is the build
spec once the audit's remaining open questions (§8) are closed.

Rides on: consolidated v5 (`coding_markdown_v5`, T1) in the reserved T3 slot.
Judge lane: deepseek-v4-flash (runner AND judge), per the standing runner
directive. No per-token spend.

---

## 0. Audit disposition (every finding, disposition)

| # | Finding | Disposition |
|---|---|---|
| F1 | Runtime count cannot ride on `benchmark_surface` (static pre-turn snapshot, chat.ts:2654, comment :3477-3480); runtime counters get their own typed event | **Fixed** — §4: `composition_check: true` static boolean on the surface; `count`/`findings` in a post-turn `benchmark_composition_check` event (the `benchmark_requirements_echo` pattern, chat.ts:3481-3488) |
| F2 | A new arm name silently no-ops the whole coding-family conformance block (`includes()` list :2581-2592) and `armExpectedSurface` falls through to null → sha gate *skipped*; "zero harness change" was false and recreated the TRIPLE-AUDIT gap | **Fixed** — §4: build REQUIRES arm added to `includes()`, `grepPerFileBudget` (:2611-2615), `completenessFloorCoding` (:2628), and `armExpectedSurface` returns the floor const so the sha gate is active |
| F3 | Coverage-short latch (`exposureNudgeServed` latched at :8514/:8528, gate `!…exposureNudgeServed` :8411) would skip the checkpoint on legitimate first drafts with unread docs → count 0 → false conformance failure | **Fixed** — §3: fire the checkpoint in BOTH refine-gate branches (coverage-short AND refine) whenever a draft body is present |
| F4 | `listLocalLibrary` returns metadata only (no `.text`); the served plane is Pandoc markdown via `servedDraftingText` | **Fixed** — §3: name `servedDraftingText` + a fixture-level byte oracle (CRLF/LF lesson) |
| F5 | "Per authoring call" false: the gate fires at most once per turn; only the first deliverable's body is checked | **Fixed** — §3 re-words honestly; first measurement accepts the once-per-turn limitation |
| F6 | Lead panel candidate (white-collar DPA, ~323K chars) violates the fit-band criterion and maximizes F3 | **Fixed** — §7: lead = closing-checklist (~118K) + fit-band banking; DPA fixture demoted to a second-wave probe |
| F7 | Claim overstates recall: `reconcileFigures` derives figures only from draft hits (:330); pure omission is invisible; competing-base requires a draft-stated percent | **Fixed** — §1 scopes to "draft-stated ambiguous-figure criteria"; §8 adds a pre-flight failure-mode check |
| F8 | Note repeats refineNote's fold-in instruction; invites churn | **Fixed** — §3: note is findings-only, no duplicate instruction |

---

## 1. The claim (scoped)

**At the draft boundary, a server-side check that reconciles the captured draft
against the served evidence plane (not the full record), folding its findings in
at the refine checkpoint, will recover criteria on *draft-stated ambiguous-figure*
criteria — the C-028/C-031 shape — that consolidated v5 drops today.**

The scope is deliberate, not a hedge: `reconcileFigures` derives its findings
from **draft-stated** figures only (legalFigureReconciliation.ts:330), so a pure
omission (draft never writes the figure — the broad S1 shape) is invisible to it.
The claim is therefore about the *wrong-or-ambiguous stated figure*, which is a
narrower but real slice of the figure class. What makes it worth measuring:

1. **The misses are composition, not read.** The dominant trace failure is S1
   "knows-but-doesn't-write" and S3 divergent quantification. No reading help
   fixes a fact the model already knows and fails to state.
2. **Every live gate audits the wrong plane.** `coverage_check` and
   `refine_check` are READ-coverage gates. A draft can be written against
   fully-exposed evidence and still state the wrong reading of an
   already-served passage.
3. **A precision-1.00 primitive for exactly this exists and was never run as a
   judged arm.** The competing-base mechanism requires the source to state the
   competing reading *verbatim* near the competing base (:420-431), which keeps
   the model-facing false-positive budget near zero. (H1/H2 omission organs are
   the natural follow-on probes but have **no** precision/recall figures — wings
   inventory:302-310 — so they are not the first probe.)

## 2. Why W5, and which finding class

`backend/src/lib/legalFigureReconciliation.ts` — `reconcileFigures(params)`
(:317) is a pure function: `{ draft, served: ServedPassage[] }` →
`{ figures, competingBases }`. No model call, no I/O. Its docstring (:1-41)
records: 181/185 derived money figures reconstruct exactly by a single
operation, zero computed-date errors, and the cost driver is **base selection and
incomplete quotation from an already-served passage** — the C-028/C-031 case:
one served paragraph states both $274,750,000 and $210,000,000 as "70%" of
different bases; the draft picked one without saying which.

The served finding class is **`competingBases` only** (:99-121, precision
mechanism :410-431): *"…the deliverable picked one of two source-stated answers
and a reader cannot tell which was meant."* `ungrounded` figures stay in the
receipt (counted) but are NOT served — a legitimately-computed-but-not-single-op
figure would be a false positive, and a false finding erodes trust in the note.

The audit empirically confirmed the mechanism fires on the real fixture
(`white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-
prosecution-agreement`, criteria C-028 "Correct Dollar Amounts for Payment
Tranches" / C-031 "Verifies Payment Schedule Arithmetic"): the draft
"The first installment is 70% net ($210,000,000)" produces one competing-base
finding (used-net, competing base $392,500,000, competing value $274,750,000),
and the gross-direction draft fires too.

## 3. The mechanism — one new flag, zero new surface

`MIKE_COMPOSITION_CHECK=1` on a new arm `coding_markdown_v5_comp`. Prompt and
tool list **byte-identical** to `coding_markdown_v5` — no new tool, no new tool
shape, no prompt delta. The mechanism appears only as a note.

**Where it fires** — inside the existing refine gate at the `generate_docx`
boundary (`localAssistantTools.ts:8408-8537`). The gate has two branches, and the
checkpoint fires in BOTH whenever a draft `body` is present:

- **coverage-short branch** (:8512-8525): unread docs named; `refineNote`
  appended; **composition findings appended too**. The model is told to read
  first AND given the figure findings — the precision mechanism's validity does
  not depend on full coverage (findings describe the served plane as-is), so
  serving them here is safe and makes the checkpoint fire even when the first
  draft was written before reading everything.
- **refine branch** (:8526-8537): coverage complete; `refineNote` + echo; the
  same composition findings append.

Firing in both branches is what makes `composition_check_count >= 1` sound for
legitimate runs: any run that captures a draft body triggers the checkpoint. The
gate latches on `exposureNudgeServed` (:8511, :8528), so the checkpoint runs
**once per turn, on the first authoring call** — which captures the first
deliverable's full body. Multi-deliverable re-sends (the refineNote's own
instruction, :8483-8487) render directly and are not checked; the first
measurement accepts this limitation.

**Served evidence plane** — the read path slices the Pandoc markdown plane
produced by `servedDraftingText` (localAssistantTools.ts:6892-6950, `bodyOffset:
0` for the coding family), and `turnReadState` retains the merged body-coordinate
`intervals` of exactly those served spans (:4570-4589). Reconstruction: for each
exposed doc, fetch that same markdown plane and slice the intervals into
`ServedPassage { document, text, at }` with `at` on the served body plane. This
**is** the doc's old "listLocalLibrary" claim corrected — `listLocalLibrary`
returns metadata only; the text must come from `servedDraftingText`.

**Draft plane** — the `body` captured at :8453 is the exact markdown saved to
`draft.md`; that same string is `reconcileFigures`' `draft`. No renderer
transformation between capture and check.

**Output shape** — the model-facing note (≤5 findings, one line each, exact
values). It is findings-only: the fold-in instruction already rides in
`refineNote` (:8480-8482), so the note never duplicates it:

```
COMPOSITION CHECK (figures): N finding(s) verified against served text.
- "$210,000,000" (net installment): 70% of the gross base is "$274,750,000" —
  both readings are in the served passage. State which base you mean.
```

The note appears **only when findings > 0**, as one additive block on an
already-required refusal — no extra round-trip, no extra call.

## 4. Internal consistency chain (every link, nothing silent)

| Link | Value |
|---|---|
| Arm env | `MIKE_COMPOSITION_CHECK: "1"` (lab-beaver-arm.ts arm env block, the `MIKE_DRAFT_EDIT`/`MIKE_COMPLETENESS_FLOOR` pattern) |
| Handler gate | `COMPOSITION_CHECK_ENABLED && requirementsState && turnReadState` → compute + append note when findings > 0 + increment `requirementsState.compositionCheckCount` (localAssistantTools.ts refine gate, both branches) |
| Static receipt | `composition_check: true` on `benchmark_surface` (chat.ts:2667-2688, env-derived like `completeness_floor`) |
| Runtime receipt | post-turn typed event `benchmark_composition_check { count, findings }` (the `benchmark_requirements_echo` pattern, chat.ts:3481-3488) |
| Conformance (build REQUIRES these) | (a) add `coding_markdown_v5_comp` to the coding-family `includes()` list (lab-beaver-arm.ts:2581-2592), `grepPerFileBudget` (:2611-2615), `completenessFloorCoding` (:2628); (b) `armExpectedSurface("coding_markdown_v5_comp")` returns `CODING_MARKDOWN_TRIAGE_FLOOR_LAB_SYSTEM_PROMPT` so the sha gate (:2652-2654) is ACTIVE, not skipped; (c) read the post-turn event (the `echo_call_count` pattern, :1981-1983) and assert `count >= 1` |
| Prompt / tools | byte-identical to v5 (floor const, same tool list) — the sha gate then passes by construction **once (b) is wired** |

The `count >= 1` assertion proves the mechanism executed even on a run with zero
findings; `composition_check_findings` tells the analysis how often it had
something to say. This chain closes the TRIPLE-AUDIT-class gap because the sha
gate references the served prompt AND the conformance block now covers the arm —
but only because (a)-(c) are explicitly in the build.

## 5. Why this is internally consistent with what v5 already carries

- **Completeness floor** (on in v5) instructs the model to make one internal
  completeness check before drafting. The checkpoint is the mechanical twin of
  that instruction for one class: no contradiction — the floor tells the model
  to look; the checkpoint tells it what the served text supports when it looks
  at figures.
- **Exposure echo is ON in v5 and the refine gate REQUIRES it**
  (`EXPOSURE_ECHO_ENABLED` at lab-beaver-arm.ts:1208; gate at :8409). The
  checkpoint does not merely coexist with the exposure echo — it **rides on the
  exposure-echo refusal** as an additive note. Only `REQUIREMENTS_ECHO` /
  `REQECHO_DRAFT_MODE` are off in T1/T3, so no T2 echo interaction is in play.
- **coverage_check / refine_check** (read-gates) and the composition checkpoint
  (draft-gate) are orthogonal planes.

## 6. Measurement — deployment conditions, never existence

Framing is the standing rule (never-dead): the checkpoint is a mechanism in the
library; this run measures *where it fires*, not whether it survives.

| Outcome | What it means | What it does NOT mean |
|---|---|---|
| Positive (within-class gain on ambiguous-figure criteria, pooled discordants favoring comp, no >25% output growth) | checkpoint rides on v5 broadly; the C-028/C-031 class recovered | — |
| Null (−2 … +2) | fires only on figure-bearing clauses; keep for those; re-measure on a figure-heavy panel | "the mechanism is dead" |
| Negative (> −2) | deployment condition is *not* competing-base reconciliation at this boundary; retire the note, keep the organs for H1/H2 probes | "deterministic organs are dead" |

The criterion-level claim is **within-class**: compare majority verdicts on the
ambiguous-figure criteria (paired, per-task + pooled McNemar via
`lab-compare.ts`), not raw totals. Tax-scale judge spread (>10 pts at fixed
treatment) is why the panel is low-noise and the head-to-head is within-class.

## 7. Eval design (first measurement)

- **Arms**: T3 `coding_markdown_v5_comp` vs T1 `coding_markdown_v5` — same
  judge, same replicates, same day. The floor is on both, held constant; any
  delta is the checkpoint.
- **Panel — genuinely fit-band only** (each candidate's total source chars
  measured first): capital-markets closing-checklist (~118K, money figures,
  verified fit-band); one fit-band banking task with figure criteria. The
  white-collar DPA fixture (~323K chars) is a **second-wave probe**, not a lead
  cell — it exceeds the fit-band criterion, and even with the both-branch firing
  fix, coverage state on a 323K task is too variable for a first clean
  measurement. (Its role is validating the mechanism on the wing's own fixture.)
- **n**: 2 per cell; adaptive third replicate only on cells where the within-task
  contrast is ±2 criteria. **Power caveat (from the audit):** at this n, a small
  or moderate effect — the honest expectation for a note that fires only on
  figure-bearing clauses — will most likely land in the Null bucket. The decision
  rule is therefore not "expect significance"; it is "did the comp arm move the
  within-class discordants at all, and did findings actually fire?" A clean
  fire-rate on findings + any within-class discordant movement is enough to
  justify a larger panel; a total silence on `composition_check_findings` across
  cells is the actionable negative.
- **Judge**: deepseek-v4-flash, k=3 majority, same judge model for both arms.
  Exact-value criteria are the most judge-stable class on the harness.
- **Analysis**: `lab-compare.ts` paired stats, deliverable-length regression
  (verbosity confound), cost table at the standard r scale. Per-run
  `composition_check_count` / `composition_check_findings` go into the analysis:
  how often did the checkpoint fire, and on how many figure criteria did the
  fold-in land?

## 8. Build dependencies (open questions from the audit)

1. **Served-plane byte identity (CRLF/LF lesson)**: the `servedDraftingText`
   plane sliced for the checkpoint must be byte-identical to the plane the Read
   path served (the coordinate-oracle lesson: verify `text.slice(start,end)`
   equals the served excerpt on a fixture before any run).
2. **Failure-mode pre-flight**: before locking the panel, confirm v5's actual
   C-028/C-031 failure on the DPA fixture is the *net-reading* shape (draft
   states $210M, omits $274.75M) and not a pure schedule omission — the latter
   is invisible to the competing-base probe (F7).
3. **Finding-class precision on the panel**: re-validate competing-base precision
   on the panel's served evidence, not just the wing's fixture.
4. **Harness edits per §4**: the four conformance additions are mandatory; a
   smoke run must show the new sha for the comp arm differs from v5 only in the
   env flag (identical prompt), and that a run with zero findings still passes
   `count >= 1`.
5. **Note grammar**: findings-only, one contiguous block matching the refine
   note's voice — the model must not read the note as a second rubric.

## 9. Sources

- `backend/src/lib/legalFigureReconciliation.ts:1-517` (mechanism, precision
  mechanism, measured record) — cited directly; NOT in the wings inventory's
  reconcilers section.
- `backend/src/lib/chat/localAssistantTools.ts:8408-8537` (refine gate, both
  branches, draft capture), `:4570-4589` (turnReadState intervals),
  `:6892-6950` (`servedDraftingText` plane).
- `backend/src/routes/chat.ts:2654-2688` (static surface), `:3481-3488`
  (post-turn typed-event pattern).
- `backend/scripts/lab-beaver-arm.ts:2581-2724` (coding-family conformance,
  requires arm additions), `:2652-2654` (sha gate), `:1981-1983` (echo-count
  read pattern).
- Wings inventory `harvey-lab-deterministic-wings-inventory-2026-08-05.md`
  :302-310 (H1/H2 precision caveat).
- Ledger `harvey-lab-index-arm-ideas-ledger-2026-08-05.md` — TRIPLE AUDIT,
  reqecho NULL, mechanism verdicts M4/M5/M6/M7.

# Deterministic primitive operationalization — hypotheses

Date: 2026-08-03 · Scope: how to *place* the deterministic primitives in the agent's
harness, once built and corrected · Status: hypothesis for approval, not yet tested.
Companion to `harvey-lab-harness-features-plan-2026-08-03.md` (the what-and-why);
this doc is the *how-to-ship-them*.

Two established constraints (both measured, not assumed):
1. **Context rot matters** — the v3 tax grounded run blew the window; Grep hops return
   20–60K-char dumps; whole-reads are the comparator the structure arms pay 30–90% more
   to tie.
2. **Tool/multi-turn churn does not translate** — coding-harness-shaped loops cost tokens
   for zero gain on these long-horizon tasks; the retained surface is one-fetch /
   one-authoring-turn / deterministic post-draft audit.

## O0 — Placement is the primary untested variable

The primitives are largely placement-agnostic: the same deterministic computation can be
(a) injected as context before drafting, (b) run as a post-draft linter/compiler check,
or (c) exposed as a model-invocable tool. We have evidence that *placement*, not the
primitive, was the failing axis:

- **fact-index was rejected on injection-only evidence.** The arm injected typed anchors
  pre-draft, scored last (169/225), and the lesson was written as "shown-but-unverified
  facts don't convert." But the same content as a *post-draft audit* (H1) is the current
  bet. Rejecting the primitive because one placement failed was shaky.
- **the cross-ref graph was rejected on untested evidence.** The audit (2026-08-03)
  showed the graph was never actually shown to the model — its only clean surface
  (`references=` query) sat on `mike_legal_v1`, never run. "Loses to whole reads" was a
  claim about a surface that didn't exist.

Consequence: when a primitive "doesn't work," the null hypothesis is placement, not
primitive value.

## O1 — Generalizable placement rules

Classify each primitive by two questions:

**Q1: Is it a verifiable property the deliverable is *supposed* to satisfy, decidable with
a typed refusal?** (derived value present · resolved date present · defined terms
resolved · no conflict · no term drift)
→ **Linter/compiler.** Post-draft, in the audit stack, bounded findings, one repair pass.
The harness corrects; the model's single authoring turn is unchanged. This is where
H1/H2/H3 + the existing conflict/temporal/term-drift organs live. Metaphor: type-checker.

**Q2: Otherwise, is its output always-relevant + cheap (structure the composer must read
to write well)?** (outline, cross-ref hubs, request-derived scaffold)
→ **One-time context injection** at surface build, bounded, read once. This is where H4/
H5 and the outline arm live. Metaphor: header/module doc.

**Q3: Otherwise (conditional, span-specific query) → model-invocable tool, designed
batched** — one call returns everything needed, never a per-section tool. The graph's
`references=inbound/outbound` is the example: expose it once, batched.

Rules of thumb:
- **Never a multi-turn tool if a one-shot injection or a post-draft audit suffices.**
  Churn is the proven anti-pattern (constraint 2).
- **Verify-or-refuse gates placement:** if the primitive cannot decide with a typed
  refusal, it cannot be a linter (would emit guesses); it may only surface evidence.
- **Context-rot (constraint 1) pushes toward linter/injection and away from tools:**
  tools add a round trip; injection costs tokens once; a linter costs tokens only when it
  fires, after drafting.

## O2 — Combinations worth testing (and re-tests of earlier rejections)

a. **Primitive × placement matrix.** For each primitive, A/B {pre-draft injection vs
   post-draft linter} with the primitive fixed. Fact-index-as-linter was never tried;
   that is the cleanest re-test of a "rejected" idea.
b. **Task-kind signature per primitive** (analytical-report / operative-draft /
   markup-analysis). Markup-analysis is the subtle one: the deliverable's job is to
   *report on* the counterparty's drafting, so the thing being analyzed must never be
   flagged — H3's quoting-vs-using boundary is the first instance; generalize it to a
   per-primitive "object-of-analysis" exemption.
c. **Cross-primitive repair budgeting.** The SLA stack funnels every organ into ONE repair
   pass. Add a determinable severity order (arithmetic > resolved dates > defined terms >
   structural scaffold) so the single pass spends its bounded budget on the highest-value
   fix. No new organ; pure deterministic ordering.
d. **Centrality (H9) as a linter target, not a ranking injection.** Rejected earlier on
   edge noise; but "did the deliverable address the most-cross-referenced provisions?" is
   a *verifiable predicate*, which Q1 places as a linter — after the audit's concrete edge
   fixes (schedule namespace, zero-padding, range ends, sub-only anchoring).

## O3 — Determinable relevance metric for the LAB scoring system

Add a deterministic, rubric-aware metric to the harness scoring (a diagnostic next to
scores.json — never a drafting-model input, per the no-hidden-rubric rule). Goal:
distinguish input tokens that are **100% not useful** (pure context bloat) from tokens
**genuinely related to the deliverable**.

**M1 — gold-requiredness (LAB diagnostic).** From each gold criterion, extract its
required claim units (numbers, percents, dates, durations, entities — the existing
`extractAnchors` machinery + a named-entity pass). Score each source document by how many
of its claim units any criterion requires. A document with zero required units is
determinably non-contributing *under the scorer's own standard* — its tokens were pure
bloat. Across a run this yields a per-task "minimal context" signature and a "wasted
input tokens" metric.

**M2 — deliverable-utilization (rubric-free; generalizes to real work).** For each source
document, how many of its claim units does the deliverable actually carry? Ratio =
utilization. Tokens never referenced by the deliverable and carrying no required unit =
candidate bloat. Caveat: utilization under-penalizes legitimate background (a 10-K
consulted for one number), so M2 is a signal read *with* M1, not alone.

Both are deterministic, bounded, cheap, and reuse existing machinery. M1 uses gold but
only for measurement — consistent with the anti-overfit rule (the rule bars injecting
rubric into the drafting model and speccing mechanisms to gold; a post-hoc score is
measurement, not mechanism).

## O5 — First test: the drafting-efficiency sub-benchmark (checkpoint-and-replay)

Proposed first experiment after the current batch lands: a *drafting efficiency*
sub-benchmark that isolates drafting-phase token cost, holding the reading phase
constant.

**Two axes, tested fairly (identical input state, different mechanics):**
1. **Drafting representation** — upstream-mike's direct `.docx` editing vs Beaver's
   "draft in markdown → deterministic `.docx` conversion." Which consumes fewer
   drafting-phase tokens?
2. **Ingestion representation** — `.docx`-as-markdown ingestion vs whole-document
   ingestion. Which is more token-efficient to read (and does it change drafting
   robustness)?

**Mechanism — replay from the same point.** The harness already emits research
checkpoints (`checkpoint_research` gate; `metrics.json` records `checkpoint_gate_calls`,
`research_checkpoint_count`, `checkpoint_handoff_hash_mismatch_count`, and the
`context-manifest.jsonl` logs per-round `usage`). The missing piece is a **replay-from-
checkpoint runner**: fork N drafting strategies from the byte-identical checkpoint that
sits at "just finished reading, about to draft," and measure only the drafting turns.
Existing runs predate the replay runner, so this tier needs new runs (as the proposal
anticipates).

**Tier 0 preview (recoverable now, imperfect):** existing grounded-cache runs already
separate `drafting_tool_calls` from `research_tool_calls` and log per-round tokens, so a
drafting-phase token slice is *measurable* from prior runs — but context states differ
across arms, so it is a directional read, not the clean A/B.

**Robustness of the simplified representation (axis-1 counterpart):** a capability-
conformance suite over `benchmarks/docx_edit/` fixtures + the pathology corpus — tables
(merged/nested cells), auto-numbering, tracked changes/redlines, headers/footers,
footnotes, text boxes — verifying that markdown → deterministic `.docx` round-trips each
feature class exactly (the existing docx kernel modules already cover these; the suite
proves it). "Simplified for the model, exact on the wire."

Rationale for making this the *first* test: it is cheap (reuses the checkpoint machinery
+ existing telemetry), isolates a variable the whole drafting surface depends on
(representation), and feeds O1's placement rules (if markdown-drafting wins on tokens,
the scaffold/linter organs should target the markdown form; if direct-docx editing wins,
they target the docx form).

## O4 — The one small slice after primitives land

The current batch (H1 wired, H2/H3 organs, outline arm) must be measured first. Then the
single slice to focus on is **M1+M2 + deterministic context-budgeting** — because it is
the only candidate that (a) attacks the proven failure (context rot) directly, (b) is
fully deterministic (zero model calls), (c) feeds back into O1 placement decisions for
every other primitive, and (d) generalizes beyond LAB. Everything else (H4–H6,
centrality) waits until the metric says where the rot actually is.

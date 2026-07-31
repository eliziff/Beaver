# Structure-graph round — registered design (2026-07-31)

Origin: Eli's design sketch across a single working session, recorded here
before any of it is built so the ablation order and the verification story are
fixed in advance. Companion to `legal-grounding-restart-plan-2026-07-31.md`
(this is its Phase 3 structure round). Nothing here has been run.

---

## 1. The idea, in Eli's terms

Three related proposals, in the order they were raised:

1. **Model-side contract modelling.** As part of a preparation stage, have the
   model "model the entire contract in some way, connecting the parts of the
   skeleton together in some sort of representation … forcing it to map it or
   graph it."
2. **Deterministic pre-graph, model-corrected.** "A deterministic attempt to
   pre-graph it by finding self-referential passages (+ a weaker layer of graph
   connections of partial matching or semantic matching within the contract
   that shows networks of not literally self referential but still connected
   ideas/concepts), that you could pre-bake and show to the model, then get it
   to correct it, then apply it to the task at hand."
3. **A lean navigation layer.** "Agent sees doc > agent asks for ToC outline >
   agent can follow tree of parent/siblings/children down, any layer with hard
   references elsewhere it sees (ablate with and without soft
   references/semantic similarity hits)." Plus, for multi-document tasks, a
   comparator over document *skeletons* rather than texts, deterministic first
   with a cheap model adjudicating the residue.

Layering, also Eli's: **deterministic layer → cheap model ensures structure →
composer reads it**, with the composer variant itself an ablation (whole
context vs. the model querying the structure).

## 2. Measured motivation

Cross-reference density over the 69 LegalBench-RAG-mini documents:

| source | explicit cross-refs | per 10k chars | definitional | pursuant/subject-to |
|---|---|---|---|---|
| **maud** | **7,491** | **13.1** | 536 | 4,675 |
| cuad | 492 | 4.1 | 42 | 684 |
| contractnli | 14 | 0.6 | 9 | 115 |
| privacy_qa | 14 | 0.8 | 1 | 41 |

maud — the source that has been this program's bottleneck for six stages — is
**16–22× more cross-referential** than the two easy sources, at roughly 2.4
references per detected section. Its gold is *fragmented by construction*:
upstream splits annotations on `<omitted>` with `max_bridge_gap_len=0`,
deliberately not bridging, giving a median gold footprint of 1,704 chars and a
maximum of **249,214**. The shipped `stitch200` bridges only *adjacent* text.
Nothing in the stack bridges **referential** distance.

**This differential is the round's built-in negative control.** A structure
intervention should help maud a lot, cuad somewhat, and be a **no-op on
contractnli and privacy_qa**. If it helps all four about equally, we have
measured prompt length, not structure.

## 3. The layers, ordered by verifiability

The ordering principle: **build the layers that can be validated without a
model first**, because this program has repeatedly mistaken unvalidated
intermediates for evidence.

| layer | edges from | oracle available? |
|---|---|---|
| L0 skeleton nodes | `compileAgreementSkeleton` | yes — spans are real or not |
| L1 hard references | reference grammar + resolution | **yes — a reference resolves to a real section or it does not** |
| L2 model relational edges | model, given L0 nodes | **partial — endpoints verifiable, relation not** |
| L3 similarity edges | lexical/semantic overlap | **no** |

L2 sits between L1 and L3 and is *better than L3*, which is not the intuitive
ordering. Given the nodes, a model can express functional legal relations that
neither literal cross-references nor lexical overlap can reach — termination
interacting with survival, an indemnity governed by a liability cap three
articles away. And if edges are constrained to name **real node labels**,
hallucination is bounded to a wrong relation between real sections, never an
invented section: an edge whose endpoints do not resolve is dropped, per the
typed-refusal rule. L3 has no verifiable component at all and is the cruder
signal.

**Correction of record:** an earlier framing in this session described L2 as
"the model builds the graph unaided" and filed it as a control. That was a
misreading — the proposal always supplied the skeleton and asked only for the
relational layer. The genuine control (a model building edges from raw text
with no skeleton) was never proposed and is not worth running.

## 4. Ablation ladder, in build order

**A. Retrieval-time edge following (deterministic, zero model calls).**
The cheapest and possibly strongest version: if a retrieved chunk contains
"subject to Section 8.2", the *retriever* follows the edge and pulls 8.2 into
the pool before any model runs. No extra tokens, no round trips, no prompt
change, no noise floor — and it attacks fragmented gold directly. Measurable on
the existing deterministic sweep. **Run this before any model-side arm.**

**B. Navigation vs. whole-context (paired composed arms).**
Outline + targeted read against a tree walk over parent/siblings/children with
hard-reference edges surfaced at each node. Requires a **step budget** —
unbounded navigation lets the model burn its turn exploring, and each step is a
round trip at 16–23 s on the laptop. Genuine tension to resolve empirically:
the rigour rule prefers navigation (it *reduces* model-visible text), the
latency constraint prefers one whole-context shot. Expect the answer to flip
with document size — maud averages ~185 sections and ~441 references per
document; contractnli and privacy_qa have almost no structure to navigate.
The navigation trace is itself a deliverable: it is citable provenance.

**C. Graph correction, isolated.**
Show the model the deterministic graph and have it correct it. Worth isolating
because it is the **H16′ shape** — hand a model a concrete artifact to *repair*
rather than compose from nothing — and H16′ produced the most decisive result
in this program (non-submission 9/9 → 1/41). Gate on whether correction raises
a *measurable* target (resolution rate, endpoint validity), not on downstream
answer quality alone.

**D. L2 model relational edges**, endpoint-verified, question-blind,
per-document.

**E. L3 similarity edges, last.** Held to the ensemble protocol: tested alone
**and** in concert, retired only on demonstrated redundancy. Prediction on
record: they will look helpful in a single run and not survive replicates.

**F. Multi-document skeleton comparator — deferred, no bed.**
Structural alignment first, cheap model adjudicating only the unmatched nodes.
This *is* the playbook-deviation workflow from
`legal-skills-ecosystem-comparison.md`, whose stated hard part is "semantic
equivalence across paraphrase" — skeleton alignment is the deterministic first
pass at exactly that. **LegalBench-RAG is single-document by construction**
(every query names its document), so none of this is testable there. Building it
against that bed would repeat the mistake that cost this program six stages.
It belongs with the case-law bed work.

## 5. Standing constraints

- **Question-blind.** Every structure pass runs per document, never seeing the
  query or the gold — the discipline that kept the R5 headers clean ("headers
  never saw questions or gold; no header→composer leakage path exists"). It is
  also what makes this a product feature rather than a benchmark trick: real
  contracts are structured once, before anyone asks anything.
- **Amortization is the cost argument.** 69 documents against 776 queries;
  per-document work is ~11× cheaper than per-query. For scale: a maud outline
  is order 11k chars and a full edge list order 18k, against the **76,800
  chars per query** the reranker was spending at `p1600`.
- **Composed arms need ≥2 replicates, paired, per source.** Deterministic arms
  need none.
- **Gate on precision, not recall.** The C1 coverage arms raised recall and
  collapsed precision 1.5–1.8×; more context invites answering rather than
  declining. Any graph arm is more context.
- **Every bar carries a registered rationale.** Sixteen bars in Stages 14–19 did
  not.

## 6. Kill criterion

If the **gold∩graph alignment** measurement shows that following edges from a
gold-bearing chunk lands mostly on non-gold text, the graph buys recall at a
precision cost *on this benchmark*, and the model-side arms should not run
against it. That would not make the idea wrong for the product — cross-reference
resolution is a real legal-work primitive — but it would mean the benchmark
cannot show it, and we say so rather than manufacturing a number.

## 7. Prerequisites

- Hard-reference graph + resolution oracle (in flight).
- Skeleton subsection detection (landed: `0fdc1e81`; contract enumerator
  capability in flight).
- perDocCap decoupled in both harness and product lanes (landed: `a40f46ee`,
  `74831c08`) — otherwise pool composition confounds every arm.

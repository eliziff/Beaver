# Structure-graph round (2026-07-31)

Eli's design. Built, unproven, never shown to a composer.
Priority 6 in `legal-grounding-restart-plan-2026-07-31.md`.

## The idea

1. Deterministic layer extracts contract structure and its internal references.
2. A cheap model checks/corrects that structure — question-blind, per document.
3. The composer reads it: whole-context, or by querying it (ablate).

Navigation shape: model sees doc → asks for outline → walks parent/siblings/
children → sees hard references at any node. Ablate with/without soft edges.
Multi-doc variant: compare *skeletons*, deterministic alignment first, cheap
model only on the unmatched residue.

## Why maud is the target

Cross-references per 10k chars: **maud 13.1**, cuad 4.1, contractnli 0.6,
privacy_qa 0.8. maud gold is fragmented by construction (`max_bridge_gap_len=0`;
median footprint 1,704 chars, max 249,214). `stitch200` bridges adjacent text
only — nothing bridges referential distance.

**Built-in negative control:** a structure effect should be large on maud, small
on cuad, absent on contractnli/privacy_qa. Equal help everywhere = we measured
prompt length.

## Layers

| layer | edges from | oracle |
|---|---|---|
| L0 nodes | `compileAgreementSkeleton` | yes |
| L1 hard refs | reference grammar + resolution | yes — resolves or doesn't |
| L2 model relational | model, given L0 nodes | endpoints yes, relation no |
| L3 similarity | lexical/semantic overlap | no |

L2 ranks **above** L3: given the nodes, a model can express functional relations
(termination↔survival, indemnity↔cap) that neither literal references nor
lexical overlap reach, and constraining edges to real node labels bounds
hallucination to wrong-relation-between-real-sections.

## Build order

- **A** — edge-following in retrieval (deterministic)
- **B** — navigation vs whole-context (paired composed arms, step budget)
- **C** — graph correction, isolated (the H16′ shape: repair beats compose)
- **D** — L2 relational edges
- **E** — L3 similarity edges
- **F** — multi-doc comparator — **deferred, no bed** (LegalBench is
  single-document by construction)

## Status: built, unproven, never shown to a composer

Commits `a8cdd08c` (shared reference-grammar kernel), `2d903c82` (graph +
measurements), then the structure round below.

**Resolver works.** At `2d903c82`: 9,234 references detected, 2,428 resolved,
24/69 documents refused. Ceiling was the skeleton's section inventory — docs
with 97–111 sections resolved 96–97%, docs with 13–33 resolved 24–40%.

### Structure round (`bdbab160`, `191c512f`, `54be6001`)

The ceiling was an EXTRACTION artifact, not a grammar limit. Every structural
grammar keys on a line start; seven maud agreements had none, their extraction
having joined each page into one line (mean line 226–310 chars vs 98–183).
`compileAgreementSkeleton` now compiles under competing whitespace-only
segmentations — offset-exact, same length, same guards — and lets the
document's own references choose. Two guards were needed and both came from
being wrong first: a reference may not endorse a provision minted out of
itself, and a hypothesis must produce heads spanning the document.

| | mini (69) | holdout (55, disjoint, untuned) |
|---|---|---|
| refused | 24 → **16** | 14 → **9** |
| resolved | 2,428 → **4,414** | 3,879 → **5,150** |
| accepted refs missing | 11.2% → **9.1%** | 17.2% → **10.5%** |

Detected (9,234 / 12,025) and external (1,720 / 2,008) are unchanged in both:
no reference grammar moved. The holdout is the anti-overfit control — same
direction, same magnitude, nothing tuned on it.

**Residue, 16 documents.** Six privacy_qa policies whose HTML headings were
flattened into a sentence stream carry ~11 internal references between them —
refusing a cross-reference graph there is correct, not a miss. Two NDAs have
no section headings and zero references, so a synthetic root buys navigation
nodes only. Four maud documents (Acacia, Anworth, Boingo, CAI — 2,016
references) are the real remaining prize and share one cause: the body
headings survive extraction nowhere, so only the contents page is visible.

**A contents page is a legitimate OUTLINE and an illegitimate span index.**
Following an edge into one lands a reader on a page number, which is why the
reach gate refuses it — but it is the drafter's own outline, and richer than
what we keep (Boingo 13 titled heads kept vs 80 in the contents reading;
holdout ASPIRITY 11 vs 102). Splitting those two products is the next step.

Measured and rejected, with its number: Text-Fidelity's later-recurrence
contents proof (`toc_outline_witness._early_heading_swarm_findings`) ports in
shape but costs resolution here (−19 mini, −110 holdout) because `uniqueLabel`
has already given the bare label to the contents entry. Its richer machinery
(dot-leader grammar, confirm-entry-on-page, monotone printed-page validation)
needs page structure that flattened text does not carry.

**Gold∩graph diagnostic (NOT a verdict).** Graph vs same-budget contiguous
control, per gold fragment: contractnli 4.06 vs 5.06, cuad 1.15 vs 6.99,
**maud 2.28 vs 1.44**.

Why this settles nothing: LegalBench gold is *where the answer text is*, not
*what must be read to understand it* — so resolving "as defined in Section 1.1"
scores as a precision loss by construction. n was 14–31 fragments per source.
24/69 documents were refused. And it measured pool expansion, not the registered
proposal (structure as orientation).

## Retirement standard

> "none of this is remotely 'retired' until the most robust deterministic first
> layer is built and we test it with real model runs across several ablations."
> — Eli, 2026-07-31

Registering a deterministic "kill criterion" was a design error: a proxy says
where to look, never what to close. Nothing here is retired. Retirement needs a
robust deterministic layer (today: 16/69 and 9/55 refused, the residue
characterized above, one untuned implementation per edge class) **plus**
composed runs across ablations, solo and in concert, retiring only on
demonstrated redundancy. The structure round strengthened the instrument; it
judged no hypothesis and no arm.

## Constraints

- **Question-blind** structure passes — never see the query or gold.
- Per-document work amortizes ~11× over queries (69 docs / 776 queries). A maud
  outline is ~11k chars vs the reranker's 76.8k **per query**.
- Composed arms: ≥2 replicates, paired, per source. Deterministic arms: none.
- **Gate on precision** — C1 showed extra context raises recall and collapses
  precision 1.5–1.8×.
- Every bar carries a registered rationale.

## Prerequisites

Skeleton subsections (`0fdc1e81`) and contract enumerators (`bdcd53e6`) landed.
perDocCap decoupled in harness (`a40f46ee`) and product (`74831c08`) — otherwise
pool composition confounds every arm.

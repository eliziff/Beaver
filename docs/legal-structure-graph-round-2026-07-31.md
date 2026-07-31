# Structure-graph round (2026-07-31)

Eli's design. Nothing here has been tested with a model.

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
measurements).

**Resolver works.** 9,234 references detected, 2,428 resolved, 3.3% unresolved,
24/69 documents refused by an integrity gate. Ceiling is the skeleton's section
inventory: docs with 97–111 sections resolve 96–97%; docs with 13–33 resolve
24–40%.

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
robust deterministic layer (today: 24/69 refused, skeleton repaired mid-run, one
untuned implementation per edge class) **plus** composed runs across ablations,
solo and in concert, retiring only on demonstrated redundancy.

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

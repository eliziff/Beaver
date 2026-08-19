# Mike one-shot context experiments — consolidated result

Date: 2026-08-03  
Status: complete; provisional visible-development evidence  
Labels: fixed Codex/Sol criterion judgments, not human gold

## Outcome

The context stack did not earn its cost. The retained architecture is the
smallest two-tool, continuous trajectory: expose the complete normalized source
set once, repeat the exact request at the evidence boundary, and author every
deliverable in one terminal batch. The best observed prompt-only variant added
a compact attention ledger and scored 178/225 at 628,072 logical tokens. The
plain native-work-product variant scored 177/225 at 597,341 tokens. Fresh pinned
Mike scored 172/225 at 590,911 tokens; two effort-matched Mike/xhigh replicates
scored 172 and 169, so the candidate result is not explained by xhigh alone.

That is a useful frontier, not a proved win. The one-point separation between
the two candidates is below observed run variance. The production candidate is
therefore the plain minimal surface; the attention-ledger prompt remains a
replication candidate rather than shipped complexity.

## Comparable three-task frontier

All rows use Luna as performer and one fixed Sol criterion judge over Banking
(65 criteria), transfer pricing (77), and indenture drafting (83). Logical
tokens are provider-reported input plus output. No row received a cache hit.

| Arm | Banking | Tax | Indenture | Total | Logical tokens | Versus fresh Mike |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fresh pinned Mike/high | 58 | 42 | 72 | 172/225 | 590,911 | 1.00x |
| Frozen Mike/xhigh, replicate 1 | — | — | — | 172/225 | 610,323 | 1.03x |
| Frozen Mike/xhigh, replicate 2 | — | — | — | 169/225 | 611,545 | 1.03x |
| Native work product/xhigh | 57 | 45 | 75 | 177/225 | 597,341 | 1.01x |
| Conflict-first attention/xhigh | 60 | 42 | 76 | **178/225** | 628,072 | 1.06x |
| Deterministic fact index/xhigh | — | — | — | 165/225 | 615,820 | 1.04x |
| Private quote-first/xhigh, replicate 1 | — | — | — | 162/225 | 616,219 | 1.04x |
| Private quote-first/xhigh, replicate 2 | — | — | — | 170/225 | 604,453 | 1.02x |
| Adaptive same-context review/xhigh | — | — | — | 175/225 | 688,751 | 1.17x |
| Large-context plan/xhigh | — | — | — | 174/225 | 1,100,703 | 1.86x |
| Monotonic same-context review/xhigh | — | — | — | 168/225 | 1,216,361 | 2.06x |
| Fresh omissions scout/xhigh | 60 | 44 | 73 | 177/225 | 1,181,068 | 2.00x |

The large-context plan row is diagnostic rather than promotion-grade: the plan
created an extra model turn, contrary to its intended same-batch trace. A
post-hoc Tax append then scored 45/77 versus 46/77 before the append.

## Fresh-scout causal test

The preregistered scout kept the native primary unchanged. Banking skipped
review below 400,000 normalized source characters. Tax and Indenture each gave
one stateless Luna/xhigh reviewer the exact original request, every normalized
source, and the frozen candidate. The host admitted only bounded findings with
an exact excerpt from a named source and preserved the original draft as an
immutable prefix.

| Task | Frozen primary | After scout | Primary tokens | Scout tokens | Net score |
| --- | ---: | ---: | ---: | ---: | ---: |
| Banking | 60/65 | 60/65 | 68,842 | 0 | 0 |
| Tax | 43/77 | 44/77 | 285,601 | 298,089 | +1 |
| Indenture | 74/83 | 73/83 | 255,735 | 272,801 | -1 |
| **Total** | **177/225** | **177/225** | **610,178** | **570,890** | **0** |

The run passed every structural gate: all requested sources were exposed, the
provider reported the default tier, tool errors were zero, reviewer calls were
well-formed, and all DOCX outputs were readable. Tax admitted 6 findings and
rejected 3; Indenture admitted 10 and rejected 2. Exact-excerpt, target, bounds,
deduplication, prefix, and hash checks therefore worked mechanically.

They did not solve selection. The only directly attributable recovered Tax
criterion was the Netherlands Innovation Box treatment. Two other Tax verdicts
flipped in opposite directions without corresponding additions, consistent
with judge or context variance. The Indenture appendix told the reader to
correct a builder-basket clause but did not edit the operative clause; that
criterion changed from pass to fail. More importantly, the reviewer did not
select the primary's actual material misses: foreign-pledge and IRC 956/TCJA
limits, after-acquired real-property collateral, regulatory delay, continuing
directors, lien priority, and fraudulent-conveyance savings.

The registered retention gate required at least 184/225 and no more than
1,181,822 tokens. The arm scored 177 and consumed 1,181,068—only 754 tokens
under the 2x ceiling—so it is rejected decisively. A patch tool would make an
accepted correction operative, but it would not repair the demonstrated
upstream failure: the reviewer did not identify the relevant corrections.

## What determinism actually earned

The deterministic verifier proved provenance and byte behavior. It did not
prove semantic entailment or materiality, and it did not select useful
omissions. Earlier deterministic evidence was similarly negative:

- The Tax fact packet spent 5,927 characters on seven repetitive generic rows
  and the arm scored 165/225.
- The source/draft audit of the planned Tax work product reported 206
  source-only anchors, 17 draft-only anchors, 147 matches, zero arithmetic
  conflicts, zero temporal findings, 25 divergent terms, and no eligible
  repair.
- The equivalent Indenture audit reported 179 source-only anchors, 2
  draft-only anchors, 84 matches, zero arithmetic conflicts, zero temporal
  findings, 40 divergent terms, two warnings, and no repair.

Accordingly, deterministic work stays off the model's mental plate and outside
the candidate context unless its semantics are objectively testable. Retain:

- exact normalized-text, version, hash, source-path, and pinpoint receipts;
- exact-substring and locator validation;
- duplicate-read and terminal-deliverable guards;
- arithmetic, date, URL-fragment, and document mutations whose correctness can
  be checked without a model; and
- exact, version-bound patches after a useful correction has already been
  selected.

Do not inject generic source-anchor dumps, divergent-term lists, broad legal
lint, compulsory repair advice, or a reviewer simply because it can produce a
verified source path. “Verified source path” means only that the named excerpt
exists in that exact source version; it does not mean the proposed conclusion
is important or correct.

## Architecture decision

The landed evidence localizes the bottleneck to attention allocation, not
document availability. On the long tasks, every source was already present.
Extra full-evidence turns rotated omissions instead of monotonically recovering
them, while unique large prompts produced zero cache reuse. Checkpoints,
evidence unions, separate drafting handoffs, source fact packets, quote ledgers,
planning turns, append-only review, and broad deterministic legal diagnostics
are therefore removed from the live candidate path.

The retained path is:

1. host-side exact normalization and durable receipts;
2. one complete evidence fetch;
3. one model reasoning-and-authoring response with the exact request made
   recent; and
4. deterministic DOCX rendering plus terminal validation.

Legal structure remains valuable as an optional navigation or exact-edit
primitive when a task actually calls it. It is not compulsory context, a
separate reasoning stage, or a reason to rename ordinary tools.

The next valid measurement is a preregistered, paired broader matrix of true
pinned Mike, the retained native surface, and the 437-byte conflict-first prompt
only. Replicate performers before promotion. Add no new context machinery. The
conflict-first prompt should ship only if its small apparent gain repeats across
long discriminating tasks and exceeds same-arm variance.

## Receipts

- Preregistration:
  `docs/harvey-labs/protocols/harvey-lab-mike-fresh-scout-preregistration-2026-08-03.json`
- Implementation before performer calls:
  `4c317bab14a2c816b7a40e50987be77dbf6755ad`
- Preregistration commit: `a5ac5b25`
- Telemetry snapshot correction: `27ec49de`
- Performer run prefix: `2026-08-03-mike-fresh-scout-v1--`
- Frozen-primary judge run prefix:
  `2026-08-03-posthoc-fresh-scout-initial--`
- Tax primary/scout transcript hashes:
  `8ef8be1a311d3d1b2ebf477f505e8bb4953d6a00ed00f2c5f96d90cbb3713ef4` /
  `9ea5c3f62f058fd7a840681afb2d4c9d3d872df68d66106fd635c4b19bde31a7`
- Indenture primary/scout transcript hashes:
  `a0e8cab29bd75f7d62d3ff2f16bf58db65bab42f68080826b77964010c53127f` /
  `d25355ec13a9dde3af916c802a2f289cccb581d556f4299e8ea470858a1f848e`

The exact local transcripts, source/draft hashes, accepted and rejected rows,
DOCX hashes, tool receipts, and fixed-Sol criterion records remain host-side in
the corresponding result directories and are intentionally not committed.

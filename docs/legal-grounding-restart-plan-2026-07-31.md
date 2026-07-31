# Legal grounding — ground-up restart plan (2026-07-31)

Written after four parallel audits (asset inventory + hot-path performance,
case-law discard audit, retrieval discard audit, bed design) established that
the program's instrument, its statistics, and in two cases its *detectors* were
defective, and that a large fraction of "falsified" ideas were never fairly
tested. This plan supersedes the Stage 19 hold-out as the near-term priority.
Stage 18R and Stage 19 are **paused**, not cancelled — see Phase 4.

---

## 1. What is actually settled

Short list, deliberately. Everything else is re-opened.

- **Deterministic verbatim membership is sound as specified.** No claim ever
  cleared the substring tier without being a substring. This is a property of a
  matcher, not evidence that quoted claims are grounded — the "wrenched out of
  context" residual (log 528–529) was never probed.
- **H16′ diff-carrying rejections work.** sonnet non-submission 9/9 → 1/41;
  19/19 adopted excerpts cleared the tier. Far outside any floor.
- **H17 prompt factorization** — prompt identity 23/23, and it produced the
  program's most useful artifact: a measured **0–13% checker-stochasticity
  floor** that everything else must now be judged against.
- **H12 suppression half** — no freely composed stands-for claim survived the
  attested arm. Deterministic mechanism, single run suffices.
- **Typed claim roles** — premise_support true 60/60.
- **R2 phrase bigrams are genuinely dead** — re-falsified on the corrected
  instrument at −0.1496 (chars) / −0.1264 (clause) overall lexical R@4. Not
  every discard was wrong, and this one wasn't.
- **The CRLF/LF portability defect** is real, unreported upstream, and ours to
  publish (LF-coordinate gold against CRLF bytes, masked by Python's
  universal-newline default; the reference harness is accidentally
  self-consistent, so published numbers are NOT wrong).

## 2. What is rotten, and the pattern behind it

Four independent failure classes, each of which produced confident verdicts:

**(a) Instrument defects.** CRLF/LF corrupted every maud number for five
stages. The D2 span double-count inflated recall (235/776 chars-arm cells
exceeded 1.0) — and **R1's falsification compared a double-counted arm against
a non-double-counted one**. D3 let rerank arm means blend a reranked and a
fallback system. Re-scoring does not repair this: re-deriving the fused arm
gives 0.8392 where re-scoring the old sidecar gives 0.8625, a measured −0.023.

**(b) Statistics borrowed from the wrong n.** The ±0.015 band was measured at
776 cells and applied to stages that ran on 32–246. At n=18 any ≤2-cell
difference is undecidable; at n=2 nothing comparative is decidable ever.
**H5 — "the harness carries grounding, not the model family," premise #1 of the
whole plan — is 8 cells over one item pair with a single false accept as the
decisive datum, never replicated.** flat_recency was retired on p = 0.264. H18
was falsified on deltas of ≤1 cell while every secondary indicator moved
favourably.

**(c) Detector blindness mistaken for a negative result.** `compileAgreementSkeleton`
finds **zero subsections across all 69 corpus documents** — the entire
`(a)/(i)/(A)/(1)` ladder never fires. On maud only ~20% of clause spans exceed
target, so "clause mode" was largely char mode with overlap 0; on privacy_qa 6
of 7 documents fall back wholesale. **R1 never tested clause chunking on the
sources where it failed.** Same shape as H10's temporal flag: "zero fires" on a
bed with zero true positives is information about specificity, not sensitivity.

**(d) Bookkeeping errors that propagated.** Stage 13's P1 read a no-submission
ladder of 7→3→2 as an effort effect; the "7" is Stage 8b's **pre-H20** number,
and Stage 9's own headline was that the H20 fix took sol 7/18 → 2/18. Corrected,
the ladder is flat (verified from receipts: pass 6 / 6 / 5 across low / medium /
max). **sol@medium — the composer in the current frozen config — was crowned on
a misattributed number**, and the crowning reduces to a latency argument.

**The pattern:** every one of these produced a verdict that *favoured the
incumbent or killed a challenger*, and rationale discipline (registered bars,
noise floors, oracles) arrived only after the adversarial audit. Sixteen bars in
Stages 14–19 have no registered rationale, including the +0.05 maud bar that the
entire skeleton discard rests on.

## 3. Principles for the restart

Non-negotiable, derived from the failures above:

1. **Instrument oracle before any run.** A `text[start:end] == answer`-class
   check at 100%, on the exact bytes the scorer will slice, asserted at build
   time. One check would have caught the CRLF defect on day one.
2. **Detector-blindness check before any structure verdict.** Measure what the
   detector fires on before concluding anything from it not firing.
3. **Bars carry a registered rationale or they don't exist.** No round numbers.
   No bar whose anchor moved between registration and run.
4. **Noise band computed from the actual n of the comparison**, per source, not
   borrowed from a larger bed. Deterministic arms are replicate-free; composed
   arms need ≥2 replicates and paired scoring.
5. **Every hypothesis ships with the control that makes it falsifiable.** The
   canonical example: court hierarchy cannot be tested without a
   **citer-count-only** arm, because apex cases are both higher-level and more
   cited.
6. **Receipts are append-only evidence.** Enforced (`--force` required to
   overwrite); one pinned receipt was already destroyed.
7. **Retrieval is precomputed and injected for composed arms**, so replicates
   vary the composer alone against byte-identical evidence.

## 4. Phase 0 — stop the bleeding (deterministic, hours, do first)

Nothing here needs a model call.

- **P0.1 — Fix the perDocCap confound.** `legalbench-rag-grounding.ts:559`
  applies `perDocCap: 24` **only when a rerank model is set**; injected pools
  (`:530`) apply no cap. As registered, Tier C arms 1–2 would run at cap 2 while
  arm 4 draws uncapped. On maud, where gold concentrates in one 300 KB
  agreement, that alone decides the arm. **Blocks every composed run.**
- **P0.2 — Fix `ensurePassageIndex` error handling.** Its `catch {}` around the
  meta read falls through to `DROP TABLE` + full reindex, so a transient
  `SQLITE_BUSY` from a concurrent reader triggers a rebuild. Observed live twice
  today. On the 5.5 GB product corpus this is catastrophic. Distinguish BUSY
  from corruption and rethrow.
- **P0.3 — Repair the skeleton detector.** Measure clause-boundary detection
  against the actual numbering conventions in the 17 maud agreements and the
  contractnli/cuad sets; extend the shared grammar with tests beside the
  existing ones (deterministic-grammar rule: no change without a corpus number).
  Then and only then re-run R1.
- **P0.4 — Withdraw the R1 falsification in the log**, with the full record:
  prong A void (instrument), prong B against an unjustified bar whose anchor
  moved, second registered prediction (maud lexR4 ≥ 0.13) HIT at 0.1662 and
  never scored, and the detector blind on the failing sources.
- **P0.5 — Log corrections**: Stage 13 P1 (the 7/3/2 misattribution);
  `stage18-retrieval-arms.jsonl` destroyed and its pinned sha no longer
  resolving; `CLAUDE.md`'s gold path (`Desktop/legal-generalization-corpus`
  does not exist — the gold is in-repo at `benchmarks/legal-generalization-corpus/`).

## 5. Phase 1 — free re-tests on banked data (zero or trivial model spend)

Highest value-per-token in the program. None of these needs a new run.

- **P1.1 — Checker-family crossing.** Registered twice (log 1299–1302, 1573),
  never run. Re-check **archived compositions** with a cross-family checker —
  no re-composition. ~150 small calls, minutes. **This either re-establishes or
  destroys premise #1 of the research plan**, on which eight stages of
  single-family checking rest.
- **P1.2 — C4 ensemble / marginal-value study.** Your own standing directive
  ("never discard a weak solo signal, never adopt a strong one alone") was
  registered five times and never once produced a result. Inputs are on disk:
  424/509 Stage 9 cells with alienness spectra, `claim_features.jsonl`, 553
  labeled claims, joinable citator columns. **Zero model calls.** Label
  EXPLORATORY (n=8 expert positives).
- **P1.3 — H7's decision-quality half.** The registered gate was disjunctive
  ("checker-call reduction **or** decision-quality gain"); the frozen falsifier
  dropped the second disjunct and decision quality was never measured. Score
  lint-firing against checker verdicts over archived Stage 7/9 receipts. Zero
  calls.
- **P1.4 — Stage 13 ladder re-analysis** (done in audit; needs one 18-cell
  `sol@low/required_slot/authority` lane to vary effort without varying policy).
- **P1.5 — Recompute the "93% of cited keys have one citer" figure** on the full
  2.54M-edge graph. It is a smoke-citator number driving live design decisions
  (thin-profile refusal, few-citers→few-propositions). One query.

## 6. Phase 2 — build the bed that can test the actual thesis

The last six stages ran on four contract corpora with **no case law, no
citations, no courts**. The citation web, court hierarchy, and attested
characterization were structurally unmeasurable there.

- **P2.0 — GATE: build the A2AJ full-text store.** Verified today: the provider
  sqlite is `metadata_only='true'`, `fts='false'`, **0 of 248,536 documents
  carry real text**. Re-run `import_a2aj_bulk.py` without `--metadata-only`,
  with `--fts`. 2–5 h background. **Everything in this phase blocks on it.**
- **P2.1 — Passage sidecars** (chars t1600/o120 + clause twin) over ~2.4M
  citable units. 2–4 h each, background, deterministic.
- **P2.2 — Bed A `canlaw-pinpoint`.** Construction is *inverted* from the
  obvious design, because the obvious design was built and **measured failing**
  (quote-in-pinpointed-paragraph 0.376–0.489, diagnosed to mixed quotation-mark
  dialect *within* courts). Instead: locate the quote in the cited case and let
  the location **be** the gold; use the judge's stated pinpoint as an independent
  instrument check (measured agreement **0.891**, and that is gate G4). 2,000
  items stratified by cited-court level × citer band, ≤5 items per cited case,
  SCC ≤40%, with a disjoint 2,000-item holdout sealed at build time.
- **P2.3 — Bed B `canlaw-attested`.** ~1,200 items from the 14,259
  single-citation paired journal footnotes whose cited case is in-corpus.
  **Author + editor gold — human, external to this program.** Single-citation
  only: string cites make proposition↔case ambiguous, and the exclusion is what
  makes the label mean anything.
- **P2.4 — Bed C `us-pinpoint`**, phase 1 local-only (CourtListener full text +
  eyecite + courts-db), per the US-materials directive.
- **P2.5 — Gates G1–G7 frozen in the log before the first build**, including the
  F1 test applied to our own bed: **ship name-stripped and unstripped as paired
  arms** so the leakage delta is a front-page number, not a post-hoc audit.

Honest scope limits to record with the bed: gold labels *the paragraph this
judge cited*, not the only supporting paragraph — **recall is meaningful,
precision is systematically understated**, and an unretrieved-but-relevant hit
must never score as a false positive. Synthetic negatives carry
`label_provenance: "synthetic_perturbation"` and measure sensitivity to a known
corruption, not misgrounding detection.

## 7. Phase 3 — the arms that were never run

Ordered by (value if true) × P(the discard was wrong).

1. **Rank policy with the citer-count-only control** — authority / banded /
   flat / **citer-count-only**, 3 models × 2 replicates. Without the fourth arm
   "authority wins" is unfalsifiable from base rates.
2. **Clause/skeleton re-round** after P0.3, with overlap-matched control, a
   clause-target sweep (never done — clause only ever ran at 1600/o0), and
   reporting at lexR@6 to match k=6.
3. **`corpusAlienness` composed ablation** — AUC 0.834 CA / 0.781 US, code and
   both indexes shipped, never given an arm. Marginal AUC over the 0.69
   novel-content baseline, per the original registration.
4. **Attested characterization at cap 3, optional** — the untested middle
   between Stage 8's optional-at-cap-8 (uptake 0) and Stage 8b's required slot
   (uptake 5/18): affordance without the coverage tax.
5. **Claude-5 re-run** under the hardened transport. Falsified on transport,
   transport fixed in the next section, never re-run; opus-5 cleared 5 of 6 hard
   case cells in the glimpse.
6. **Doc-name-blind rerank arm** — replaces `document` with an opaque ordinal.
   Decides whether the +0.258/+0.406 R@4 rerank gain is capability or filename
   matching. A 48-pool spans only ~10.8 documents and gold occupies 19% of
   contractnli slots, so filename matching alone discards ~81% for free.
7. **Charlotin adversarial probes** against the H12 contract — the one
   registered falsifier that tests it against *real* recorded misrepresentations.
   Registered, explicitly deferred, never run. 121 Canadian rows are
   citator-probeable.
8. **H13 prong 2 (consensus-inversion lint)** and **D3's lint form** (divergence
   from the stands-for profile weighted by citer count and court level — your
   hierarchy prior operationalized). Both blocked on the citator build, which
   completed in Stage 8; nobody came back. Deterministic, and each becomes a
   free C4 column.
9. **B4 — mine sanctioning judgments for judicially-provenanced claim labels.**
   The corpus currently has 63 checker-derived + 14 expert positives and zero
   judicial ones. This gates every C4 verdict.

## 8. Phase 4 — close out LegalBench-RAG cheaply

Do **not** add stages. Its remaining value is two things, both already in hand:

- one honest hold-out number on the corrected instrument, with the ten
  registered disclosures; and
- the CRLF portability finding, filed upstream as an issue with the 10-line
  reproducer and the 84-probe table (LF 59/84 vs CRLF 31/84), plus a
  regeneration guard asserting no `\r` in any corpus file.

Run Tier C **after P0.1**, at one replicate, with pooled retrieval injected —
~70 minutes. If it cannot separate G+ctx from plain G at the measured band, the
crowning unwinds to plain G and *that* is what the hold-out sees. Then stop.

## 9. Performance work already banked today

All output-identical, all on the laptop-CPU production path:

| commit | fix | measured |
|---|---|---|
| `17884220` | document body fetched once per search, not per hit | sweep 13m → 4m06s (**3.2×**), receipt byte-identical |
| `1e73f86b` | rank without fts5 content columns | ranked query 50.4 → 23.5 ms/q; 6-config run **2.65×**; 2,352 cells digest-identical |
| `53d3bed8` | narrow + memoize per-hit metadata row (product lane) | 157.9 → 54.9 ms/q (**2.9×**) |
| `7da4f03d` | batch citator alias expansion (one graph open per query) | 4.77 → 1.35 ms/q (**3.5×**); 200 keys 137 → 20 ms |
| `0cadfd44` | cache context-sidecar digest | 70.8 → 62.8 ms/q (11%) |
| `7da4f03d` (second, undescribed hunk) | `standsForProfile`: first-occurrence paragraph/excerpt ride the `MIN(text_offset)` row instead of a per-group re-fetch | top-cited keys 155.1 → 61.1 ms median, 338.3 → 154.7 p90, 190.3 → 80.7 mean; thin keys 4.1 → 1.3 ms; 80-key sweep 7.8 → 3.3 s. Output fingerprint identical (`242f4c14…`), 80/80 profiles equal field-by-field |

Product a2aj passage lane: **157.9 → 40.8 ms/q, 3.9×.** 1,096 backend lib tests
pass. Measured negative results, recorded so nobody re-investigates:
`stmt.iterate()` is 3.6× *slower*; SQL `substr()` per hit is slower than the
memo; `charPrecisionRecall`/`unionLength` is 0.1% of a sweep (the sweep is 98.9%
`searchPassages`); `setReturnArrays` is ~3.5% and costs positional access.

Citator hot-path measurements, so nobody re-opens them:

- **`noteUpCitations` needs no equivalent fix.** It runs the same per-group
  shape, but its page caps at 50 groups, so the loop is ~10 probes and is not
  the cost: top-cited median 36.2 ms is the two full scans, not the lookup.
- **`commentaryCandidates` is already clean** — one query, JS loop over its own
  rows, ~1.5 ms per profile. No per-row query.
- **An index on `edge(cited_key, case_id, text_offset)` is the remaining
  lever, and it was NOT applied.** `totalCiters` (~30 ms) and the grouped
  query (~40 ms) both walk `edge_cited_idx` and then fetch every row just to
  read `case_id` — ~11.3k rows × ~600-char excerpts to compute one integer.
  Measured on a bounded side table over the 80 benchmark keys, a covering
  index takes `COUNT(DISTINCT case_id)` to 0.24–0.40 ms and the group-by to
  0.30–0.51 ms (`SEARCH ek USING COVERING INDEX`). Treat as an optimistic
  bound: 124k rows fully cached vs 2.54M in production. Not applied because it
  is a schema change to a shared 2.28 GB store that concurrent sessions read,
  it belongs in `scripts/build_citator_graph.py`, and the disk is 98% full.
- **Citer-count distribution over all 540,948 distinct `cited_key`** (73.9 s
  full scan), which **corrects the "93% of cited keys have one citer" figure
  that P1.5 flags** — the smoke-citator number is wrong on the full graph:

  | citers | keys | share | cumulative |
  |---|---|---|---|
  | 1 | 336,257 | 62.16% | 62.16% |
  | 2–12 | 178,763 | 33.05% | 95.21% |
  | 13–50 | 21,460 | 3.97% | 99.17% |
  | 51–300 | 4,059 | 0.75% | 99.92% |
  | 301–1000 | 350 | 0.06% | 99.99% |
  | 1000+ | 59 | 0.01% | 100% |

  So thin-profile refusal fires on **62%** of keys, not 93%, and the
  `STANDS_FOR_CONSIDERED = 300` cap binds on only 409 keys (0.076%).

## 9b. Session status, 2026-07-31 (what landed, and two corrections of record)

**Phase 0 — all four correctness fixes landed.** `1ca6a238` never reindex on a
transient sqlite lock (a `SQLITE_BUSY` from a concurrent reader was triggering a
full `DROP TABLE` + rebuild; hit live twice). `9d4eafe6` receipts append-only in
all three harnesses, via a shared `experimentReceipts.ts`. `a40f46ee` one
explicit per-doc cap for every arm, recorded on the row. `1d220fce` resume keys
carry every meaning-bearing dimension (the key omitted `arm`, and
`--coverage/--spec/--plain/--exclude-gold` all change the arm — the flags C1a,
C1b, F2 and F3 ran under). Backend suite 1,427 passing.

The perDocCap confound was **~16× the composer noise band** — maud lexical
recall 0.0210 → 0.1672 at k=6. Tier C as registered would have compared two arms
at cap 2 against an uncapped injected pool and produced an uninterpretable
result.

**Product lane, same defect class, decoupled** (`74831c08`). `a2ajPassageSearch`
spelled the cap `rerankModel ? 24 : undefined`, so reranking could not be
changed without silently changing document diversity — a confound under every
rerank number this codebase has produced. Behaviour preserved and *measured*:
over 160 real queries, `undefined` and explicit `2` are byte-identical at k=8
and k=48. Recorded honestly: the un-reranked `2` is `searchPassages`' own `?? 2`,
which entered with the benchmark ablation harness in `3997cf12` and carries no
rationale, unlike every other default in that function. The cap binds hard
(k=8: cap 2 → 4.54 documents/query, cap 24 → 1.49), so it is a real search
policy question — and the benchmark's answer must **not** be copied, because
uncapping wins there only because every LegalBench query names its one gold
document. Owed: a measurement on a text-bearing product corpus.

**CourtListener widened.** New slice at 384 MiB compressed → **55,504 opinion
rows against the previous 17,343**; import in flight. The audit found only
1,332 of 17,343 opinions carried any text, so the US lane was effectively not
local.

### Correction 1 — the skeleton was never "blind to subsections"

An earlier claim in this session, that `compileAgreementSkeleton` finds zero
subsections across all 69 documents, was **a measurement artifact of the probe
that produced it**. `toBlock` flattens every node kind onto `kind: "section"`,
so counting `doc.blocks` returns zero subsections by construction. Counted over
`skeleton.nodes`: contractnli 30, cuad 475, **maud 1,842**. Consequences:
`structuralChunkText` already consumes subsections, and **R1 was not character
chunking on maud** (zero fallback documents there). The privacy_qa fallback is
real (6 of 7) but is an unnumbered-heading problem, not an enumeration one.

The real defect underneath, found and fixed (`0fdc1e81`): `statuteSpine`'s
label-alone-on-line extension — the measured `_EXT` that lifted LEGISLATION-NS
0.795 → 0.963 — matches **centred page numbers** in agreements, and a run of
page numbers is monotone, same-arity and document-spanning, so it clears every
guard, wins the scope competition and then *suppresses the real headings*. Ten
of 69 agreements drew a mostly or entirely contentless spine. Fix: a label-alone
mark may **extend** a spine, never **constitute** one. Non-regression shown:
960 statutes across all 16 A2AJ sets byte-identical (recall 0.8714 / precision
0.9926 over 39,371 provider gold labels, unchanged); 1,020 of 1,029 corpus
documents hash-identical; gold-span containment 88.33% → 88.62%.

Open, measured, deliberately not yet fixed: contract-style `a)` / `1)` (33
lines) and `a.` / `iv.` (66 lines) enumerators.

### Correction 2 — bars, and what "measure first" costs when skipped

Both corrections above, plus the Stage 13 misattribution and the F1 artifact,
share one shape: **a number was produced by an instrument nobody had validated,
and a narrative was built on it.** The restart principles in §3 exist because of
this, and §3 principle 2 (detector-blindness check before any structure verdict)
was itself derived from getting this wrong twice in one day.

## 9c. Registered: the structure-graph round

Design registered in full at `docs/legal-structure-graph-round-2026-07-31.md`
before any of it is built — layers ordered by verifiability, ablation ladder in
build order, standing constraints, and an explicit kill criterion. Headline
points: the cheapest version is **deterministic edge-following at retrieval
time** (no model, no tokens, no round trips); model-built relational edges over
a given skeleton rank **above** similarity edges because their endpoints are
verifiable; the maud-vs-contractnli/privacy_qa cross-reference density gap
(13.1 vs 0.6–0.8 per 10k chars) is the round's built-in negative control; and
the multi-document comparator has **no bed** on LegalBench-RAG and is deferred
rather than forced.

## 10. What we explicitly do not do

- No new LegalBench-RAG stages beyond Tier C and the hold-out.
- No re-test against a bar that has no registered rationale — fix the bar first.
- No composed verdict on a delta inside the band computed for *that* comparison's n.
- No rebuild of the citator, journals, or alienness indexes — they are built;
  query them.
- No model-derived or checker-derived label promoted to gold.

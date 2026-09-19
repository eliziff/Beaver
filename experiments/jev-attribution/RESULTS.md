# Jev attribution experiment results

Model `jev-1.13.0` via `POST /v1/systemone` (`model: "jev-latest"`).
53 calls, 53 successes, 0 transport failures. Median call 0.341 s, max 0.856 s.
673,865 input and 421,642 output tokens across all runs.

Boundary scoring is mechanical (`compareDecisionStructure`). Attribution and
treatment scoring is the main agent's own reading, frozen before the calls.

## 0. CSLB adversarial-passage judging (Jev, 2026-09)

**Task.** Judge whether a legal-writing request makes claims a cited passage
supports. Benchmark: `benchmarks/legal-generalization-corpus/cslb/repo/data/
a2aj_benchmark.jsonl` (500 items; 100 curated adversarial false-premise prompts,
400 benign). Sources fetched by neutral/statute citation from the public A2AJ
API (`fetch_cslb_sources.py` → `receipts/cslb-sources.json`); the pinpoint
paragraph plus one neighbor, or the statutory section, goes in state with the
request quoted as evidence. One call per item.

**Result on the 355 items with a resolvable passage** (`run_cslb_judge.py`,
tag `cslb4`):

| Arm | n | Result |
| --- | ---: | --- |
| Adversarial detection | 73 | **73/73 (100%)** — 30/30 pinpoint-summarization, 43/43 sentence-completion |
| Benign false alarms | 282 | 2 (0.7%) |
| Overall | 355 | 353/355 (99.4%) |

Detection confidences run 0.6–1.0; the two benign misses are a 0.59 `absent`
where the gold continuation quotes another case and a 0.56 `contradicted` on a
quotation the passage rewords. All 73 adversarial items are upstream-curated
false premises (reversed holdings/tests/orders, wrong sections, nonexistent
pinpoints); nothing was regenerated to match Jev.

**Harness finding (three discarded formulations).** Jev's answer depends on the
decision's *form*, not just its content. Stated as request-safety ("may the
writer proceed?") it complies with 100% of adversarial requests at median
p(refuse) 0.23; stated as claim verification ("supported / contradicted /
absent") it is near-perfect at 0.98–1.0 confidence on the same items. Judge
propositions, not policy verdicts — consistent with the independent-questions
constraint.

**Implication for framing.** Task 1's 29% adverse recall was measured on
whole-memo claims against retrieved sources. The passage-level skill behind
this benchmark is essentially flawless, so the framing gap lives in claim
localization and subtle-overreach comparison, not in Jev's ability to check a
stated claim against a shown passage. Rerunning framing in statement form is
the obvious next step.

## Full-generation-set + whole-decision state (2026-09, tags `ffull`, `fwide`)

The statement-form judge was rerun over the *full* generation set (512 rows,
Opus checker verdicts on disk; 93 adverse) — a fresh batch relative to the
holdout, same question, no retuning: **69/93 adverse caught (74%), 21/412
false adverse (5.1%)**; quote-only arm 60/77, source-context arm 9/16.

**Context was the binding constraint, not the judge.** The framing state had
only the extractor's single ~6k excerpt centered on the quotation (cap hit in
462/512; quote missing in 16/512). Re-judging the 24 misses with the complete
decision in state (fetched from the A2AJ API, 100k-char cap): **10 of 16
re-judgeable misses flipped to adverse** — implied full-decision recall on
this set ~79/93 (85%). Of the 21 false-adverse re-judged wide (12 re-judgeable,
9 no-source), **5 flipped back to supported, 6 stayed adverse** — the wider
window nets positive on both arms rather than trading recall for precision.

Remaining misses with whole decisions: 6 adverse claims still read supported
(p 0.77–0.88, genuine-overreach band) and 6 supported claims still flagged
(p 0.35–0.89, most on 100k-truncated decisions). The residual is threshold
tuning plus a long-document ceiling, not context retrieval.

## Whole-set whole-decision run (tag `wide-all`) and the threshold verdict

All 512 claims re-judged with complete decisions in state (124 rows dropped:
citation unresolvable at the A2AJ API; 132/388 scored rows sat at the 100k-char
cap). Head-to-head on the same 388 rows, at the 0.70 acceptance cut:

| State | Adverse recall | False adverse |
| --- | ---: | ---: |
| 6k window | 75.0% | 4.4% |
| Whole decision (all) | 69.1% | 9.2% |
| Whole decision, uncapped only (n=256) | 67.5% | 6.1% |

Whole-document state did **not** reproduce the misses-only gains: on matched
rows it is slightly worse on both arms at 0.70, and the entire gap sits in the
132 capped rows (18 of 103 supported flagged, 19/29 adverse caught — both arms
degrade when the 100k cap truncates). The earlier misses-only rerun (10/16
flips) selected exactly the rows where the window was the problem; over the
full set, extra context is roughly neutral on small decisions and harmful on
truncated ones.

**Conclusion.** Neither arm of the original recommendation survives contact
with the full set: statement-form prompting is already in place and the
delta-question probe is dead; a supported_p threshold alone is the honest
operating point. At 0.70 on window state, full-set numbers are 75% recall /
4.4% review load (holdout confirmed 55% / 4.3%). Route to review any verdict
whose state was truncated — that gate recovers most of the capped-arm loss
without new model calls. The residual overreach band (supported_p 0.77–0.88,
6–19 rows depending on state) remains Jev's genuine limit.

## Framing rerun in statement form (512-item holdout, tag `fstatement`)

Same holdout, same Opus proxy verdicts, same state; only the question changed.
The definition of support was sharpened to require the source to state the
claim *as written*, with adding conditions, widening the rule, or outside
knowledge counting as `unsupported` — the exact overreach mode of the 42
proxy-adverse claims.

| Metric (proxy labels) | Old framing run | Statement form |
| --- | ---: | ---: |
| Adverse caught | 12/42 (29%) | **25/42 (60%)** |
| False adverse on proxy-supported | 1/469 (0.2%) | 23/468 (4.9%) |
| Separation AUC (supported_p) | 0.953 | 0.940 |
| Adverse stuck in 0.5–0.9 band | 22/42 | 27/42 |

Trade-off, stated plainly: the stricter reading doubled adverse recall
(29% → 60%) at the cost of 23 false adverse on supported claims (0.2% → 4.9%).
The remaining 17 misses all sit at supported_p 0.64–0.89 — Jev sees the claim
as mostly-true rather than partitioned, so a 0.5 threshold reads them wrong;
raising the acceptance bar converts them without touching the 445
supported-at-≥0.9 agreements. The 31–42-token output bimodality persists.


## 1. Quote attribution is the strong case (43/46)

Ten frozen passages across six decisions: 2017 ONCA 1012, 2015 YKCA 17,
2020 SCC 32, 2018 NSCA 53, 2006 SCC 16, 2007 FCA 24, 2001 CMAC 2.

| Dimension | Result |
| --- | --- |
| `words_belong_to` (present court / cited authority / decision under review / party or counsel) | 6/6 |
| `proposition_speaker` | 6/6 |
| `is_verbatim_quotation` | 5/6 |
| `advanced_by_party` | 6/6 |
| `court_endorses` | 4/6 |
| opinion relationship (separate opinion, judge of deciding court, agrees with disposition, agrees with reasoning) | 16/16 |

The core distinction the request was built around — is this the present court,
a cited authority, the decision under review, or counsel — was correct on every
item, including the hard cases: a lower-court costs endorsement quoted and then
reversed, a SCC quotation reached only through defence counsel's reliance, and a
factum passage quoting a trial judge.

### The three disagreements

All three are on the *endorsement* and *quotation* dimensions, not on who the
words belong to.

1. **A1 `court_endorses`** — quoted the application judge's $30,000 costs
   determination and endorsing it, at 0.88. The Court of Appeal in fact replaced
   it with the agreed $42,500. **Partly my expectation's fault**: the excerpt
   opens with a premise the Court of Appeal does adopt ("the parties agreed
   ... $42,500") and ends with a determination it reverses, so a single boolean
   is a coarse question for this passage.
2. **A1 `is_verbatim_quotation`** — 0.39 for a passage that is a verbatim
   blockquote. A genuine miss.
3. **A5 `court_endorses`** — 0.54 for a factum allegation the court does not
   adopt. A genuine miss, and near the decision threshold.

**Practical reading:** quote attribution and party-versus-court separation are
directly usable. "Does the court endorse this" is the weak dimension and should
be split or gated by confidence rather than trusted as one boolean.

## 2. Opinion boundaries (mechanical)

Nineteen decisions from both benchmark generations, scored exactly.

| Run | Documents exact | Exact starts | Exact ends | Exact opinions |
| --- | --- | --- | --- | --- |
| run1 (naive instructions) | 6/19 | 14/25 | 20/25 | 11/25 |
| run2 (benchmark-matched instructions) | 10/19 | 21/25 | 19/25 | 14/25 |

By generation, run2: superseded multi-opinion cohort 3/5 documents (7/11
opinions); fresh v2 cohort 7/14 documents (7/14 opinions).

### Instruction iteration mattered more than the model

The first pass encoded "start at the first numbered paragraph". Jev obeyed, and
was then scored wrong on most of the fresh cohort, because the benchmark's own
convention starts at the opinion's label line (`By the Court:`, `The judgment of
the Court was delivered by`, `ORDER`, `JUDGMENT AND REASONS`,
`SUMMARY OF APPEAL/RESPONSE`, `COSTS ENDORSEMENT`). Stating that convention
raised exact starts from 14/25 to 21/25.

The tradeoff is also visible and should not be hidden: the same change made the
end instruction more permissive and *lowered* exact ends from 20/25 to 19/25,
including one 21-line overshoot (2011 NSSC 377). Further tuning against these 19
documents would be fitting the gold, so it was stopped here.

### What explains the residual failures

Opinion **count** was right on 19/19 and the multi-opinion check agreed 19/19, so
the model perceived how many opinions there are and where they sit. Every
remaining miss is about which *non-substantive* lines belong to the span.

1. **Heading attractor — caused by my instruction.** My rule said to start at
   "the body heading that introduces those reasons". In 2007 FCA 24 Jev then
   chose line 123 under the `ISSUES` heading instead of the dissent's author
   label at 96/97. In 2018 NSSM 50 it chose line 91, `21. The Court's reasons for
   decision are as follows`, even though a literal `REASONS FOR DECISION` heading
   sits at line 88 — instead of the block start 33. Both are Jev obeying a
   heading rule, not misreading the law.
2. **The same rule fails in the opposite direction.** 2018 FC 873 skipped
   `JUDGMENT AND REASONS` (23) and started at `[1]`; 1999 BCCA 364 skipped the
   author heading (16) and started at 17. Heading inclusion is unstable in both
   directions, so no single instruction fixes it.
3. **Tail overreach into appended apparatus — also caused by my instruction.**
   My "include trailing disposition, order, and date lines" rule let 2011 NSSC
   377 run to line 104, deep inside the appended erratum/metadata block
   (`ACJ`, court name, citation, counsel, `Erratum:`), instead of stopping at 83.
   The three ±1 end overshoots (2006 SCC 16, [1940] SCR 547, [1964] SCR 402) are
   the same overreach at one line.
4. **Under-reach at terminal exchanges.** 2018 BCCA 341 stopped at the
   disposition (95) and excluded `[38]`–`[41]`: `WILLCOCK J.A.: I agree`,
   `[Submissions by counsel]`, and the closing colloquy. Where joinder lines and
   post-judgment exchanges follow the disposition, "end of opinion" is genuinely
   undefined.
5. **Gold is internally inconsistent.** 225088 excludes a standalone
   `Reasons for Judgment of the Honourable Madam Justice Fenlon:` heading, while
   1999 BCCA 364 includes the equivalent. One residual cannot be satisfied by any
   instruction.

Direction of the two runs: the naive instructions under-included headings and
pushed starts late (14/25 exact). The matched instructions fixed starts (21/25)
and over-included tails (ends 20/25 → 19/25). That is a precision/recall
tradeoff on non-substantive lines, not a comprehension gap.

The identical failure class appears in the older records: Luna Max's named
residual was "nearly exact boundary quotes", the largest validator rejection
class was "short but exact boundary anchors" (54), the 649-case residual included
112 missing start anchors and 82 missing end anchors, and the experiment's own
note records that spans writing "several instead of just one" and "excluded
certain paragraphs" meant "luna is not being instructed well here". Boundary
disagreement on this corpus has consistently been a convention problem for both
models.

## Jev versus the deterministic engine

Same 19 decisions, same line units, same gold. The deterministic extractor
(`deriveTextOpinionStructure`) was run locally on each document; Jev is run2.

| | Deterministic | Jev |
| --- | --- | --- |
| Documents with exact boundaries | **2/19** | **10/19** |
| Status: `ready` | 8 | — |
| Status: `unresolved` | 3 | — |
| Status: `unavailable` (found no opinion block) | 8 | — |

Per document:

| Outcome | Count | Documents |
| --- | --- | --- |
| Jev exact, deterministic wrong | **9** | 225088, 75090, 7330, 149002, 141895, 139305, 51408, 127974, 128450 |
| Both exact | 1 | 224889 |
| Deterministic exact, Jev wrong | 1 | 4521 (Jev off by the heading line) |
| Neither exact | 8 | 198059, 112050, 187607, 86759, 138815, 195108, 183, 129680 |

The value is specifically on cases the deterministic engine cannot produce:

| Deterministic status | Documents | Jev exact |
| --- | --- | --- |
| `unavailable` (returned nothing) | 8 | 5 |
| `unresolved` | 3 | 2 |
| `ready` | 8 | 3 |

So Jev is exact on **7 of the 11 documents where the deterministic engine is
unresolved or returns nothing at all**, and on 5 of the 8 where it returns an
empty opinion list. Concrete failures deterministic cannot fix:

- 2001 CMAC 2: deterministic collapsed three opinions into one span `29-174`;
  Jev returned all three exactly.
- 2015 YKCA 17 and 2014 BCCA 146: deterministic emitted spurious 16-word
  candidate blocks (`33-37`, `49-55`) and was marked unresolved; Jev was exact.
- 2008 ONCA 273, 2017 ONCA 1012, 2013 NSSM 34, 2021 NSPC 51, 2014 NSPC 58:
  deterministic reported "no substantive opinion block found" and returned
  nothing; Jev was exact on all five.

Where Jev is not better: it is wrong on 4 of those 11 (2018 FC 873, 2018 NSSM 50,
2011 NSSC 377, [1964] SCR 402), and it loses the single document deterministic
gets right (1999 BCCA 364). On this sample Jev alone (10/19) also beats "use
deterministic when `ready`, otherwise Jev" (9/19), because Jev is exact on two
`ready` documents the deterministic span collapses.

This is 19 documents, unstratified, on one reviewer's gold. It is an indication
that the model path adds coverage the rules cannot, not a rate to quote.

## Comparison with other models

There is no head-to-head run of another model on this adapted task, so this is a
comparison in kind, not a controlled comparison. The closest evidence is Luna Max
(`gpt-5.6-luna`, max effort) on the superseded nested contract in this repository.

| Measure | Luna Max, nested contract | Jev, adapted task |
| --- | --- | --- |
| Median case latency | 484 s (semantic MVP 15) / 535 s (case-target MVP 15) | 0.34 s |
| Input tokens per case | ~29k–36k | ~5k–34k (whole document supplied) |
| Output tokens per case | ~19k plus ~15k reasoning | ~4k–22k, no reasoning tokens |
| Boundary outcome | spans exact 30/30 on *oracle-ready SCC* (a selected easy subset); 60.9% span-partition self-consistency on a random 30 | 10/19 documents exact, 21/25 starts, 19/25 ends, count 19/19 |
| Validator | required several correction rounds; v4 salvaged 86.9% of replayable rejections | none for attribution; mechanical comparator only |
| Complete records | 3/15 semantic MVP, 5/15 case-target MVP | not applicable (one narrow answer per question) |

Two honest caveats cut in opposite directions. First, Jev was **not** given a
harder task: line ids were supplied, so locating text in unnumbered prose — much
of what the old validator policed — was removed. Second, Luna Max was answering a
far richer contract (opinions, authors, joiners, vote blocs, issues, target
mentions, treatment events, direct history) in one call, and its acceptance
passed a strict validator that Jev's narrow answers never face. The clean,
non-cherry-picked win is latency and transport reliability: 53/53 calls, no
retries, no schema repair, sub-second.

On the superseded fine-grained treatment labels, no external benchmark is
comparable: different task, different label set, different corpus. The only
defensible statement is the measurement itself — 2/4 on the ten-way label, with
near-flat distributions. That is a signal the taxonomy is under-determined at
that granularity, not a league-table placement.

Opinion **count** was correct on 19/19 documents and the Noul multi-opinion
check agreed with the gold structure on 19/19.

## 3. The superseded fine-grained treatment labels (9/12)

Applying the retired vocabulary to four fixed target occurrences.

| Dimension | Result |
| --- | --- |
| `target_identity` | 4/4, confidence 0.97–1.00 |
| `legal_actor` (court vs counsel) | 3/4, confidence 0.60–0.99 |
| `treatment_operation` (10 labels) | 2/4, confidence 0.25–0.56 |

`target_identity` and `legal_actor` — the attribution half — are again solid.
The retired `treatment_operation` set fails for a measurable reason: Jev's own
probability mass is spread across adjacent labels rather than committed to one.

| Item | Chosen | Confidence | Distribution |
| --- | --- | --- | --- |
| T1 | referred_to | 0.25 | referred_to .33, explained .24, distinguished .17, applied .14 |
| T2 | distinguished | 0.25 | distinguished .33, referred_to .23, limited .18 |
| T3 | referred_to | 0.56 | referred_to .62, applied .30 |
| T4 | referred_to | 0.34 | referred_to .41, applied .38, explained .17 |

This is direct evidence for the reason those labels were superseded: at this
granularity the distinction is not recoverable, and the model reports that
honestly through a flat distribution. The attribution dimensions that replaced
them are the ones that score well.

## Corpus scale and cost

Measured on the boundary stage (39 calls, mean 103.7 lines/document, range
35–217):

| Measure | Value |
| --- | --- |
| Input tokens per document | mean 17,174 (range 6,369–34,332) |
| Input tokens per line | ~169 (line-id options are repeated across the boundary questions) |
| Output tokens | Metered but free on current TypeSafe pricing |
| Cost per document | ~$0.0007 at $42 per billion input tokens |
| Latency per document | 0.24–0.58 s |
| Whole experiment (53 calls) | $0.028 |

One pass over the 225,162-decision local corpus extrapolates to **~$162** and,
at sub-second calls, a few hours of wall time when parallelized. Cost is not the
obstacle.

Two real obstacles:

1. **The 255-option cap.** One Choice question accepts at most 255 options, which
   caps the line-id pattern at 255 lines per call. My sample never exceeded 217
   lines, so **the windowing path is untested**. Longer decisions need either
   chunking into ≤255-line windows with a Noul per window, or the documented
   two-pass window-then-rank.
2. **Accuracy as configured is not corpus-ready.** 10/19 documents exact
   (53%). Count was 19/19 and starts 21/25 (84%), and the misses are the
   heading/signature/order lines a deterministic layer already resolves. The
   defensible production shape is therefore Jev proposing candidate boundaries
   for the cases the deterministic extractor cannot resolve, with deterministic
   code owning the exact span — not Jev as a standalone span oracle.

An untested cost optimization: ask only the count first, then send start/end
questions for the reported count instead of always asking five speculative
pairs. Most of the input is the repeated option list, so this should roughly
halve per-document tokens on single-opinion decisions.



## Jev on the case-treatment hard slate (30 decisions, 12 multi-opinion)

`backend/experiments/a2aj-case-treatment/gold/gold-structure-30-v6.jsonl`, scored
in character-space IoU. Line units matched exactly (0 mismatches).

| Configuration | Scored | All opinions IoU>=0.9 | Mean IoU | Single | Multi |
| --- | --- | --- | --- | --- | --- |
| hybrid: per-line begins + windowed ends | 30/30 | 20/30 | 0.762 | 17/18, 0.979 | 3/12, 0.438 |
| v2: author-label classifier, no cap | 27/30 | 9/27 | 0.349 | 8/18, 0.439 | 1/9, 0.170 |
| v3: classifier + count cap (state bug) | 27/30 | 20/27 | 0.819 | 15/18, 0.822 | 5/9, 0.813 |
| v4: state chunked + widened cap | 30/30 | 13/30 | 0.458 | 9/18, 0.494 | 4/12, 0.405 |
| v5: state chunked + strict count cap | 30/30 | 21/30 | 0.758 | 15/18, 0.820 | 6/12, 0.665 |
| v6: v5 + deterministic refine rules | 30/30 | **23/30** | **0.849** | 17/18, 0.935 | 6/12, 0.721 |

| v7: recall-first candidates + Noul arbitration | 28/30 | 16/28 | 0.661 | 12/16, 0.738 | 4/12, 0.559 |
| v8: v7 candidates + TOC count cap + v6 pruning | 28/30 | 19/28 | 0.767 | 13/16, 0.803 | 6/12, 0.719 |

| v9: v8 candidates, headnote fix, no count cap | 30/30 | 9/30 | 0.317 | 8/18, 0.443 | 1/12, 0.128 |

v8 solves the failure class v6 could not reach: `[1988] 1 SCR 30` went from 0.10
to **0.99** (4 predictions against 4 gold) and `[1995] 2 SCR 513` from 0.00 to
**1.00** on its four gold opinions, via headnote exclusion plus joint-opinion and
trailing-signature pruning. Overall it still trails v6 (19/28 against 23/30)
because capping candidates by the count answer drops one begin in `2003 SCC 33`,
`[1990] 3 SCR 697`, `[1993] 1 SCR 471` and `2002 BCCA 142`.

v9 removed the count cap in favour of deterministic pruning alone and
over-detected badly (6 predicted starts for 2-opinion decisions, 12/50 opinions
at IoU>=0.9). The count cap is load-bearing: it is the only brake that keeps the
recall-first candidate set precise.

Conclusion from the v5-v9 sequence: this benchmark sits on a precision/recall
seesaw. Recall-first candidates fix the SCR multi-opinion cases, but they need the
count answer to stay precise, and the count answer is unreliable on long documents
in both directions (3 for a 4-opinion decision, 5 for a 4-opinion decision, 3 for
a 2-opinion decision). Unreliable opinion enumeration on long documents is the
bottleneck, not boundary comprehension: v6 remains the best overall at 23/30, and
no configuration tried beats it.

| v10: count-free, shape-gated begins | 30/30 | 18/30 | 0.669 | 17/18, 0.931 | 1/12, 0.277 |
| v11: v10 + `J.A.`/`J.C.` label shapes admitted | 30/30 | 20/30 | 0.700 | 17/18, 0.929 | 3/12, 0.356 |

Count-free design note: the number of opinions and the opinion boundaries are the
same information (count is `len(spans)`), so asking the model for a count and then
letting it cap the boundaries is using a derived quantity to veto a primary one.
v10/v11 remove the count question and the cap entirely: boundaries are read off
the per-line decisions, gated by a local author-label shape, and the count is
computed in code. That is why single-opinion returns to v6 quality (17/18, 0.93)
with counts derived correctly (18/18), while multi-opinion still trails.

This also qualifies the v6 headline. v6 reached 23/30 **using the count cap**, the
mechanism identified above as unsound, so its advantage is partly attributable to
a step that should not exist. The sound count-free configuration currently
reaches 20/30. The remaining multi-opinion gap under v11 is shape-gate precision
in both directions: it over-admits name-plus-`J.A.` lines inside SCR headnote and
citation tables (`[1988] 1 SCR 30` predicted 8 against 4) and under-admits
non-name labels (`2002 BCCA 142` predicted 1 against 5, `2004 SCC 61`,
`2018 YKCA 9`, `[1993] 1 SCR 471` all predicted 1 against 2).


(rescue bare `Reasons for judgment:` / `Decision:` / `REASONS FOR JUDGMENT`
labels, prefer a body heading over a front-matter `REASONS FOR JUDGMENT: NAME`,
drop headnote `Per X J.:` lines when inline author labels exist, drop trailing
signatures, drop bare `X J.` sub-headings inside a joint opinion). The 23/30 is
the combined system, not the raw model. It fixed `2011 NSCA 118` (1 to 3
opinions, 0.00 to 0.99 IoU) and `2004 FCA 389` (25 to 40), lifting single-opinion
from 15/18 to 17/18, but over-pruned two SCR decisions (`[1988] 1 SCR 30`
0.40 to 0.10, `[1995] 2 SCR 513` to 2 predicted against 4 gold).

Recorded numbers for other candidates on this slate: Luna Max 22/30 acceptable
boundaries, counts 30/30; on its all-multi-opinion hard ten, 99.93% mean
boundary overlap and 70/80 structure categories. Sol Low 19/30 acceptable,
Terra Max 20/28.

What the iteration established:

- The multi-opinion failures were **mostly a convention mismatch**. Gold starts
  at the author label (`THE CHIEF JUSTICE--...`, `BEETZ J.--...`), and my earlier
  instructions excluded author labels while inviting heading-anchored starts, so
  Jev selected the SCR **headnote's** `Per Wilson J.:` summary lines instead.
- Separating `opinion_author_label` from `headnote_summary` and `section_heading`
  as a per-line 4-way Choice, with the author label treated as part of the body,
  raised multi-opinion mean IoU from 0.438 to 0.813 and overall from 0.762 to
  0.819, at some cost to single-opinion (0.979 to 0.822).
- Dropping the count cap was a regression of mine (12 begins for a 5-opinion
  case); capping by the reported count restored it.
- v3 produced no result at all for the three largest decisions (189928 at 1121
  lines, 195153 at 979, 192926 at 834), because it sent the whole document as
  state for every 150-line question chunk. v5 chunks the state and scores all 30.
- Selecting begins by count cap alone over-detects when the cap is widened
  (v4: 5 begins for a 2-opinion case); a strict count cap is what holds.
- v3 used 241,842 input tokens for the slate against the hybrid's 1,196,993.

Not established: Jev matching Luna on multi-opinion boundaries. Its multi-opinion
mean IoU is 0.665 against Luna's 99.93% mean overlap on its all-multi-opinion
hard ten. On the aggregate acceptable-boundary metric the two are level
(21/30 against 22/30), but that mostly reflects the single-opinion majority of
the slate.



## What is and is not established

Established on this sample: attribution of quoted material is reliable
(43/46, and 20/20 on whose-words / whose-proposition); the model path recovers
opinion boundaries on documents where the deterministic extractor returns
nothing (5 of 8) or an unresolved/wrong span (7 of 11); cost is negligible.

Not established: any rate to quote. Nineteen unstratified documents, twenty-five
opinions, ten attribution passages, four treatment targets, one reviewer's
expectations. The boundary span convention is partly a gold artifact, including
one internally inconsistent pair. Thresholds, the hybrid begin/end design, and
any document longer than 217 lines are untested or tested once.

Reproduced numbers live in `receipts/`; designs that were tried and their
measurements are above rather than replaced.

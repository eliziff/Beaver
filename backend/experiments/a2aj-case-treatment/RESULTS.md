# Results

## 2026-08-29 simplified v3 contract

The active contract now stores one object per cited decision. That object has
only its exact identifying span, an optional direct outcome, and the treatments
stated by each judicial opinion. The separate grouping and procedural-history
surfaces have been removed. A direct outcome is limited to what the present
court actually does to the cited decision; other same-proceeding narrative is
not a separate ontology.

The extraction prompt, structured-output schema, compiler, receipts, export,
semantic view, judge schema, judge prompt, scoring, and single launcher now use
the same shape. The v2 gold is preserved as `gold-v2.jsonl`; its 121 records
were mechanically projected to v3 and all validate, but the projection is not
being represented as a new semantic audit. No live inference was launched.

TypeScript checking and all 41 focused experiment tests pass.

## 2026-08-29 case-wide v2 contract

The active contract now has exactly two model stages: opinion structure, then
one whole-case treatment reading. The treatment call receives the complete
decision and the accepted opinion structure. It does not receive citation
candidates or a pre-authored authority inventory.

The analysis result contains only cited decisions, proposition-level treatments,
and same-proceeding procedural history. Reproduced source passages live directly
on the treatment they support. The occurrence ledger, voice labels, attributed-
passage table, and reverse-use table were removed. The semantic judge sees only
treatments and procedural history; source mechanics and citation coverage are
not judge tasks.

The prior 121-record gold is preserved unchanged as `gold-v1.jsonl`. Active v2
gold keeps all 714 treatments and 154 history records, projects 2,320 occurrence
rows into 2,094 source-local cited-decision rows without guessing unresolved
aliases, and retains the 342 reproduced passages actually used by treatments.
Fifty-six metadata-only components and
27 unused passage rows were left behind. An initial scalar `decision_id`
projection incorrectly collapsed decisions cited together and lost two genuine
case entries. Treatments therefore use `decision_ids`; the corrected projection
retains both entries. All 121 active records validate.

The same citation check runs after a model draft using only source text,
accepted opinion boundaries, deterministic citation/footnote links, and draft
spans. It suppressed three apparent omissions where footnote links established
that an already-listed case name and a neutral citation were the same authority.
Gold is not an input to extraction, correction, or production receipts. No live
inference was launched for this contract revision. The backend build and all 41
focused experiment tests pass.

## 2026-08-22 fresh proposition-first harness

The new experiment is isolated from the superseded issue-based gold and runner.
It now has one gold contract for one-stage and two-stage inference, complete
decision context, open-ended reference recall, proposition-level treatments,
separate procedural history, exact line-local anchors, Beaver evidence
receipts, bounded drafting-time correction, mechanical scoring, and a semantic-
only judge surface.

The first local audit corrected two material harness defects before new gold or
live inference:

- substantive-coverage validation had treated too much front matter as judicial
  reasons; it now asserts coverage only for paragraphs inside high-confidence
  deterministic opinion bodies; and
- benchmark aggregation had silently omitted rejected, failed, or interrupted
  cases; it now reports every case requested by the run manifest.

The compiler also enforces the existing 40-word substantive-opinion floor,
grounds each named participant/writer/joinder in source text, retains detector
keys for later citation resolution, and handles a sole collectively authored
opinion without automatically counting a judge who expressly agrees only in
the result.

No new model inference has been launched under this contract yet. Fresh gold
selection and authoring must pass the process in `GOLD.md` before a comparative
run.

The tracked fresh draw contains 30 court decisions across all 14 configured
court datasets and overlaps none of the 427 containing decisions recovered
from earlier experiment gold. Replacing a full 11 GB text-table scan with an
indexed ID pool plus primary-key eligibility probes reduced seeded selection
from about 20 seconds to 1.05 seconds on this workstation. Thirty complete
authoring packets then compiled in 6.4 seconds with eight workers.

## 2026-08-22 Luna High canary

The 15-record gold file validates cleanly. Across the five completed Luna High
cases, gold-aware mechanical grading accepted all five opinion structures and
all 40 structure categories; mean boundary overlap was 99.6%. One boundary was
accepted because Luna omitted only a duplicated order block. Another included
a trailing judicial signature; compilation removed it deterministically while
retaining the raw model output and an adjustment receipt. These were simple
single-opinion cases, so multi-opinion majority/minority performance remains
unproven.

Semantic judgment graded 14 treatments pass, one minor, and four major
(76.3%), with no invented treatment. The major errors were omissions.
Procedural-history accuracy was weaker (56.3%; 70.4% combined). A later
authority-cluster experiment was abandoned: repeating the full case for each
authority fractured connected propositions and made grading invalid. Treatment
inference now remains one case-wide call.

## 2026-08-27 case-wide Luna Max comparison

Ten court decisions were run through one structure call followed by one
whole-case treatment call. All ten outputs compiled. Mechanical opinion grading
accepted all 80 categories after treating judicial short-name/full-name forms
and non-substantive headings as equivalent. Every case had one opinion, so this
does not establish majority/minority performance.

An adversarial re-read found that the gold had omitted twelve valid
proposition-level treatments, chiefly appellate treatment of judicial decisions
under review. Those relationships now coexist with, rather than replace, their
separate procedural-history records. The corrected 15-record gold validates.

Against the corrected ten-case subset, below-normal Sol Low grading produced:

| Luna Max path | Treatment | Major treatment errors | Procedural history | Overall |
| --- | ---: | ---: | ---: | ---: |
| Structure → treatment | 80.7% | 6/44 | 60.7% | 75.9% |
| Structure → authority inventory → treatment | 80.7% | 8/44 | 53.3% | 73.7% |

The inventory arm used 29 accepted-stage calls versus 19 analysis calls for the
baseline, with about 17.6% more output tokens and 20.2% more summed call time.
It recovered some omissions, including the complete Toth stay test and the
three lower-court propositions in `2016 YKCA 11`, but introduced different
omissions and did worse overall. It will not be part of the default pipeline.

The current default remains structure → one whole-case treatment analysis,
with exact-source validation and targeted JSON Patch correction. Its opinion
result on this narrow slate is promising; its rate of material treatment and
procedural-history omissions is not yet sufficient for corpus-scale use. The
next benchmark expansion must include multi-opinion decisions and treat
judicial decisions under review at both the procedural and proposition levels.

## 2026-08-28 100-case gold expansion

The benchmark now contains 115 records: the original 15 and 100 newly selected,
mostly court decisions. The 100 additions were authored directly from fresh
source packets under the proposition-first standard in `GOLD.md`; none were
converted from the superseded issue-based annotations.

Every new record received two complete adversarial source readings. The first
checked reference completeness, opinion structure, and attribution. The second
re-tested the legal meaning of every treatment and procedural-history claim.
Corrections were applied directly to the gold rather than preserved as a
separate change ledger.

After both passes, all 115 records pass source, structure, grounding, and
coverage validation. The focused experiment suite passes all 29 tests. The
expanded set is benchmark gold; no inference comparison has yet been run on
the 100 new decisions.

## 2026-08-28 hard multi-opinion comparison

Ten deliberately difficult appellate decisions were added: five Supreme Court
of Canada decisions, including decisions from 1988, 1990, 1993, and 1995, plus
FCA, ONCA, BCCA, NSCA, and YKCA decisions. Each contains two to five opinions.
The ten records were authored from the complete primary text and read twice
adversarially. That audit corrected a material gold omission: when an opinion
evaluates a proposition from the decision under review, the gold now records
both that treatment and the separate procedural relationship. All 121 current
gold records pass source, structure, grounding, and coverage validation.

Luna Max identified every opinion count and writer. Across the 80 mechanical
structure categories it scored 70/80 (87.5%): full joiners 8/10, partial
joiners 6/10, opinion results 9/10, participant votes 8/10, and nonparticipants
10/10. Mean boundary overlap was 99.93%; harmless judicial bylines, section
labels, and punctuation are accepted, leaving only Owen's omitted final
disposition paragraph as a boundary failure. The conservative no-oracle detector
scored 21/70 (30.0%), so Luna added substantial structure information.

Against the corrected gold, below-normal Sol Low judging scored Luna's legal
treatments at 78.7% and procedural history at 65.9%, for 77.8% overall. Six of
ten decisions passed the 80% per-case threshold. Of 283 reference treatment
propositions, 214 passed, 24 had minor errors, and 45 had major errors. Most
major errors were omissions. Eight candidate treatments lacked a gold match;
six were minor over-segmentation and two were major attribution errors. Eight
majority-support errors were all minor and concentrated in two fragmented
panels. Luna is useful for filling deterministic opinion gaps, but these hard
cases do not support unreviewed corpus-scale publication yet.

## 2026-08-29 scaled 30-case model comparison

The frozen comparison contains 30 court decisions from 12 court datasets: the
hard ten, both additional multi-opinion decisions in the fresh 100, and a
seeded draw of 18 single-opinion decisions. Twelve decisions have multiple
opinions. Every arm used the same two-stage prompts and schema, ten workers,
below-normal priority, retained raw output, and checkpointed corrections. The
completed hard-ten Luna receipts were reused; only its 20 additions were run.

| Candidate | Contract accepted | Treatment | Overall | Multi-opinion treatment |
| --- | ---: | ---: | ---: | ---: |
| Luna Max | 23/30 | 77.8% | 75.5% | 78.6% |
| Sol Low | 27/30 | 64.1% | 64.0% | 62.0% |
| Terra Max | 25/30 | 51.5% | 52.5% | 47.3% |

Terra's score treats its two structure-stage failures as omitted gold
propositions rather than silently dropping them. All 30 Sol and Luna cases and
all 30 Terra cases received semantic scores; no provider call failed. The
established Sol Low judge was also the Sol candidate model, a possible source
of bias in Sol's favour, but Sol still trailed Luna materially.

Luna found 30/30 opinion counts, 27/30 writers, and acceptable boundaries in
22/30 cases. Sol found 30/30, 25/30, and 19/30 respectively. Terra was exact on
opinion count for all 28 cases that reached a structure receipt, but two hard
multi-opinion decisions produced no usable structure; among those 28 it found
22 writers and 20 acceptable boundaries. On the 12 multi-opinion cases, Luna
scored 7/12 on partial joinders, Sol 6/12, and Terra 6/10 judgeable structures.

The scale-up exposed and corrected one gold omission in Egan: Cory and
Iacobucci JJ. adopted Linden J.A.'s account of the allowance's purpose while
rejecting the discriminatory means. The corrected 121-record gold validates
121/121 and the experiment suite passes 39 tests. Judge aggregation now gives
deterministically exact cases full credit and counts absent semantic drafts as
omissions instead of excluding both from the headline score.

Luna Max is the clear candidate for further work, especially on fractured
panels, but it remains below the 80% semantic threshold and is not ready for
unreviewed corpus-scale publication. Sol Low is adequate for much of the
mechanical structure task but not proposition treatment. Terra Max supplied no
quality gain here and failed most sharply on the difficult multi-opinion cases.

## 2026-08-29 v6 contract ablation

The next Luna comparison holds the opinion pass, cases, gold, compiler, and
semantic judge constant while varying only the treatment output contract.
`simple` asks for treatment semantics and source blocks, then derives the
treating opinion in the host. `self-check` additionally asks Luna to state the
opinion and copy short verbatim support; the host aligns that text and checks
the attribution independently. Both arms compile to one flat treatment record.
The second arm must name the first with `-StructureRunName`; the runner then
reuses those structure checkpoints and refuses to call a model for that stage.

The canonical ten-case v6 gold validates 10/10. No live inference result has
been recorded for this ablation yet.

The final preflight found several contract seams before live inference: model
mentions are now limited to judicial material and carry an exact copied label;
result-only agreement is a mechanical structure score; receipts retain that
vote data and the cited label; and a shared opinion pass is rejected unless all
non-treatment run settings match. Initial model calls now record the system
instruction and response schema hashes; correction calls record the same
system hash and request JSON Patch arrays. These are local contract checks
only; they do not add a v6 quality result.

## 2026-08-29 direct-coverage prompt ablation

The current simple contract, fresh ten-case gold, accepted Sol Medium opinion
checkpoints, judge, and all run settings were held constant. The only treatment
change told the model to work through every opinion from beginning to end,
return every distinct treated proposition, keep separate records across
opinions, and not stop at representative treatments.

All ten treatment drafts compiled. Compared with the original Sol Medium run,
the direct prompt increased candidate treatments from 177 to 228, raised the
treatment score from 78.3% to 85.1%, and reduced omitted gold treatments from
40 to 20. Gold treatments graded pass increased from 191 to 212. Major errors
on matched treatments increased from 8 to 13 as the model attempted more, while
unsupported major extras remained 2. Procedural history, whose prompt was
unchanged, moved from 64.0% to 62.5%. Overall score rose from 77.0% to 83.2%.

The dense five-opinion BCCA decision improved from 33 to 44 returned treatments
and from 59.1% to 80.3% treatment accuracy. The prompt therefore fixes a large
part of the observed compression, but the remaining 20 omissions show that a
single case-wide pass is not yet exhaustive.

## 2026-08-30 procedural-score audit

The current procedural score is not yet a clean measure of whether a model
found the decision under review and its principal disposition. In 2011 FCA 272,
seven of eight completed outputs identified the appealed order and reversal but
lost the entire relationship because they omitted the separate costs variation.
The same all-or-nothing pattern appears when a model finds an overall appellate
result but omits one affected part. Keep this as a possible instruction or
scoring-granularity failure; do not weaken the gold until the pattern is tested
on more decisions.

The temporary-care order in 2025 NSSC 123 was not a separate decision directly
affirmed, reversed, or varied by the present court. Its procedural relationship
has been removed from the gold while its source mention remains in the decision
inventory. Existing candidate and judge receipts remain frozen and have not
been re-judged.

## 2026-08-30 structure-diversity transport canary

Nine two-case Luna structure members ran through one Node process and one Codex
app server at six-call concurrency. All 18 case outputs compiled; there were no
provider or transport failures. Supported variation across low/medium/high
effort, three reading orders, and conservative hints produced a distinct
structure for every member on both cases.

One direct low member scored 16/18 mechanical categories. A three-member medoid
reached 17/18 (94.4%); nine members did not improve further. The sole remaining
error omitted Stratas J.A.'s express partial joinder in `2011 FCA 272`. Opinion
counts, exact boundaries, writers, full joiners, result positions, participant
votes, and nonparticipants were all exact. This canary supports testing a small
cheap ensemble, not ten-member consensus by default.

## 2026-08-30 product-aligned Simple versus hypersimple

Ten Luna Max cases used the same complete decisions, shared opinion-structure
checkpoints, one analysis audit, ten workers, and below-normal priority. Both
arms produced accepted analyses for all ten cases. The product gold contains
348 treatments, six direct-review relationship groups containing eleven scored
actions, and seven reported appellate-history statements.

| Analysis contract | Gold-item accuracy | Treatment | Direct outcome | Reported history | Extra-claim precision |
| --- | ---: | ---: | ---: | ---: | ---: |
| Simple | 80.7% | 81.8% | 72.7% | 42.9% | 90.5% |
| Hypersimple | 82.2% | 83.2% | 81.8% | 35.7% | 88.8% |

Hypersimple used about 15% fewer output tokens and 16.5% fewer reasoning tokens
than Simple, with essentially unchanged wall time. It therefore preserved the
useful semantic result in this single matched run while removing fields the
host can derive. This is an ablation result, not evidence that one headline
signal always preserves every multi-operation treatment.

The benchmark is not yet ready for a corpus-scale quality conclusion. The
judge found 71 source-supported Simple extras and 87 hypersimple extras,
concentrated in treatments of decisions directly under review. Those are gold
completeness challenges, not model errors, and must be checked against the
primary decisions before another model comparison. Reported-history recall was
also weak in both arms. The prompts now state expressly that an affirmance or
reversal remains in scope when embedded in chronological prose. Scoring now
uses gold items for the headline and reports extra-claim precision separately;
an accurate extra can no longer offset a missed gold proposition.

## 2026-10-06 corpus-scale opinion boundaries

The current product gold contains 1,000 decisions, 1,343 opinions, and 192
multi-opinion decisions. The 930 fresh additions were authored with Sol 6.1 low
and received two primary-source audits each; earlier records retain their
historical provenance. The latest source and full product validations passed.
These remain model annotations, rather than human-reviewed reference judgments.

The installed A2AJ store contains 225,187 case records. The 14 court datasets
covered by this gold account for 171,473 records; 15 other datasets account for
53,714 and have no records in this gold. SCC supplies 174 of the gold's 192
multi-opinion cases, but only 10,891 of the court corpus records (6.35%). Its
34.1% share of the gold is useful for difficult boundary evaluation and must not
be used as a corpus workload estimate.

The product-validation report asserts source coverage for 307 of the 1,000
cases: 44/49 BCSC, 46/52 FCA, 55/341 SCC, and 0/51 ONCA, among other courts.
This is not a measurement of boundary accuracy. `caseMaterial.ts` enables that
check only when the existing text detector declares the complete structure
ready and supplies substantive spans. The detector's readiness also requires
resolved authors, alignments, and judge result sides. Therefore a usable body
partition can remain unresolved because another structure field is unknown.

The proposed approach is a measured cascade:

1. Freeze a stratified holdout from the independently sourced 930 additions
   before tuning. Benchmark the current detector's opinion counts and substantive
   boundaries separately from authors, joinders, and votes. Report silent
   merges, splits, omitted reasons, excluded conclusion paragraphs, and included
   publisher/counsel matter by court, era, language, and source format. Mean
   overlap alone can conceal an omitted short opinion or disposition.
2. Give boundary acceptance its own evidence and measured error criteria.
   Extend the existing native source and paragraph primitives for tested formats;
   retain unknown authors and votes when the source does not settle them. Genuine
   source opinion markup can supply components directly, but the current A2AJ
   authoring route uses provider text or section maps. The native
   `source_opinion_components` query exposes actual markup roles and does not
   infer opinions from a byline. It is not a substitute for text-boundary
   detection on inputs without that markup.
3. Send uncertain partitions to one whole-case structure-only model call with
   exact-source compilation and targeted corrections. Benchmark model choices
   on the holdout before selecting the corpus route. Try a second independent
   reading on disagreements or difficult partitions; the old two-case ensemble
   canary is insufficient evidence for a corpus-wide consensus policy.
4. Retain distinct outcomes for published reasons found, reported disposition
   without published reasons, and unresolved source structure. Brief oral reasons
   and bare joinders need separate evaluation. The latest gold admission rejected
   three reported-only sources; forcing them through a minimum-one-opinion schema
   cannot create a supported body of reasons.
5. Process the existing store in bounded, resumable batches. Persist accepted
   exact spans through the existing projection/persistence primitives, bound to
   the canonical source hash and extractor/contract identity, including compiler
   fingerprints for durable native projections. Sample accepted records by format
   cohort, and retain uncertain cases for further work. Add targeted gold for the
   other 15 datasets before extending acceptance to the whole installed corpus.

The next experiment is a boundary-specific deterministic baseline and calibrated
model fallback against the frozen gold. No new corpus-wide model run or native
grammar change was made for this assessment. Aggregate store counts and coverage
observations are retained in the private expansion run's
`boundary-corpus-analysis.json`.

## 2026-10-06 runner token review before corpus scale

The first boundary-only format was paused after the 186-case frozen holdout and
63 completed corpus records. Its receipts remain in the ignored
`benchmarks/local-data/a2aj-opinion-boundaries/50k-sol61-low/boundaries.sqlite`;
seven in-flight call receipts have no completion/usage and are not counted as
completed calls. The runner process exited and its isolated authentication copy
was removed. This is not a completed 50,000-record run.

The 325 completed calls recorded 4,052,786 input tokens, 31,683 output tokens,
1,579 reasoning tokens, and 578,560 cached input tokens. Output was about 0.78%
of input plus output tokens. Removing copied edge text can reduce output, but
repeated complete-source input is the larger opportunity. The 69 cases with
multiple completed readings retained the same opinion count and source status;
their secondary calls used 1,004,651 input tokens, including 156,160 cached tokens.
That does not establish that the rereads added no boundary value. The original
holdout recovered 183/186 opinion counts and 162/186 acceptable boundary sets.
Its gold oversamples difficult SCC opinions, so these token totals are not a
production workload estimate.

The revised v2 format uses constrained source-unit IDs and optional exact quotes
only when an edge falls inside a unit. It also records source-supported panel
and nonparticipant names, opinion writers, and full/partial joins in the same
call. A shared label dictionary and packed integer references avoid repeated
name strings in storage. Attribution failure preserves valid boundary spans.
Ordinary multiple opinions or a mismatch with the uncalibrated detector no longer
trigger a second full-source reading; reported-only classifications and explicit
range contradictions still do. Rereads/corrections append after the stable source
prefix. `evaluate` can run the holdout without starting the corpus. The v2
focused tests pass, including name/evidence round trips and precise partial-unit
edges. The subsequent live comparison is recorded below.

## 2026-10-06 Luna Max routing evaluation

Both models used the revised v2 prompt and output schema on the same frozen
186 cases, without reference answers in their prompts. The account catalogue
and a subscription canary verified `gpt-6-luna` with `max` effort. No API key
or alternate provider was used. The completed receipts are retained privately in
`sol61-low-v2-eval/boundaries.sqlite` and `luna-max-eval/boundaries.sqlite` under
`benchmarks/local-data/a2aj-opinion-boundaries/`.

| Measure | Sol 6.1 low | GPT-6 Luna Max |
| --- | ---: | ---: |
| Exact opinion counts | 185/186 | 180/186 |
| Acceptable boundaries under the existing comparator | 139/186 | 136/186 |
| Exact writers | 180/186 | 164/186 |
| Exact full joins | 170/186 | 154/186 |
| Exact partial joins | 181/186 | 168/186 |
| Exact participating panel | 179/186 | 169/186 |
| Completed calls | 227 | 225 |
| Input tokens | 2,751,931 | 2,709,277 |
| Output tokens, including reasoning | 39,868 | 313,533 |
| Reasoning tokens | 4,404 | 278,327 |
| Cached input tokens | 323,968 | 358,912 |
| Mean completed-call seconds | 8.46 | 21.34 |
| Median completed-call seconds | 6.89 | 14.86 |

The protocol was frozen before inspecting comparison results: try Luna only on
modern, monotonically numbered, non-SCC sources without detected separate
opinions. A Luna output also needed one source-valid opinion with a writer;
otherwise the simulated route used Sol. The 107 candidate cases were hash-split
into 53 selection and 54 validation cases. Every measured boundary/name category
had to equal or exceed Sol in both splits, with at least 20 cases per split.
The route failed writer accuracy in selection (48/53 versus 51/53) and validation
(52/54 versus 53/54); full joins also fell in validation (50/54 versus 51/54).
Its small boundary-score gains did not satisfy the separate attribution gates.
The corpus route therefore remains Sol 6.1 low.

Luna is technically usable and its published Standard credit rates are lower.
Applying those rates to the recorded completed-call usage gives approximately
9.88 credits for Luna versus 132.18 for Sol; this is a rate-card illustration,
not a measure of included subscription usage or this account's bill.
[Official credit rates](https://learn.chatgpt.com/docs/pricing#token-rates).
Max substantially increased reasoning and latency on this task. These cases
oversample difficult SCC material and do not estimate corpus-wide prevalence.

Boundary scoring retains the existing comparator. Source review found some
failed edge comparisons differing only in overview headings, bylines, or quoted
signatures; those were not retroactively relabelled to select a route. Names and
joins are scored against the independent gold rather than merely counting
source-compilable attribution. The v2 score cannot be treated as a passing
corpus accuracy gate or as human-verified gold.

The 50,000-record v2 corpus run has started in
`50k-sol61-low/boundaries-v2.sqlite`. It reuses the completed Sol holdout, records
the original evaluation submission and database hash, and samples exactly
50,000 additional records outside all 1,000 gold decisions. Completion, error
counts, and final storage size will be recorded after the run finishes.

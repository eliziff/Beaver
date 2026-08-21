# A2AJ decision-roster results

## One-citing-case/one-target Luna Max MVP (2026-08-19)

Run `case-target-mvp-15-luna-max-v1` completed all 15 frozen pairs with ten
independent ephemeral workers. Each call received one complete public citing
decision, one target identity, and the deterministic target-occurrence map;
no target decision text was supplied. There were no process failures or
timeouts. Median call time was 534.55 seconds (361.42--754.02), with 537,793
input tokens, 235,131 output tokens, and 177,748 reasoning tokens in total.
The exact raw ledger is 561,120 bytes and the full receipt stream is 593,279
bytes.

The frozen v1 receipts report 13 `accepted_with_target_rejections` and two
opinion rejections. The raw outputs were revalidated locally after four general
validator corrections: a proved occurrence ID wins over a redundant model
quote; punctuation-only quote variation can resolve through the shared source
token index; repeated identical panel evidence in the pre-reasons header uses
the first exact occurrence; and direct-history outcome evidence may appear
later in the same opinion than the target citation.

The current fail-closed revalidation accepts 14/15 opinion records and 5/15
complete case-target records. Across the 14 opinion-valid cases it accepts
51/64 opinion-issue positions, 30/37 target mentions, 25/32 treatment events,
and 1/1 direct-history events. Acceptance is now atomic per subrecord: a failed
mention, issue link, partial joinder, treatment, or history item cannot enter
the accepted arrays or the derived treatment graph. Rejection receipts identify
the exact component and reason. The main remaining failure is Luna placing an
issue card's own evidence outside its declared discussion span, followed by
changed or invented quote text. Those claims remain rejected.

The deterministic `flat_treatment` projection worked on surviving events. It
keeps controlling, other-judicial, and attributed labels separate by issue and
derives retrieval flags without asking the model for a scalar good-law score.
Examples include controlling `applied` edges in `2005 FC 894` and `2021
FPSLREB 61`, and a controlling `referred_to`/`explained`/`applied` combination
in the partially accepted `2007 TCC 547` record.

## Fast deterministic storage and selection (2026-08-19)

The durable boundary remains newline-delimited JSON: the representative
15,000-case audit ledger is 17,721,477 bytes and its measured final write took
168 ms. JSON is no longer an IPC transport. Parser workers write contiguous,
ordered JSONL parts once and return only counts and filenames; the parent
concatenates those bytes. A 32-case fixed-seed comparison had zero receipt or
document-order differences from the earlier ledger.

Model answers now have a separate append-only `.outputs.jsonl` ledger. Exact
raw output is written there before validation; progress and case receipts keep
its SHA-256 instead of duplicating the answer and parsed rejection. Concurrent
appends are queued per file and covered by the runner self-test. Compact
streaming receipts are now the default, so the final run summary does not hold
or duplicate the whole receipt library.

Random `ALL` selection now draws seeded primary keys and rejects the small
ineligible set through indexed lookups instead of scanning every decision.
One-case selection plus a dry receipt fell from 14.8 s to 0.95 s. A 15,000-case
manifest took 1.48 s and contained 15,000 unique IDs across all 29 datasets.
The bulk document reader now fetches 500 IDs per SQLite query and omits unused
citation-graph columns.

The storage check also found a deterministic false positive in `2004 BCSC
1220`: `At para. 22, Sopinka J. stated:` had been treated as an opinion start.
Reported-speech verbs are now rejected as paragraph-author markers; the real
sole panel author, Crawford J., is recovered. The focused corpus case and 38
boundary tests pass.

## Open-source baseline and court-roster inventory (2026-08-19)

The local corpus has 225,162 decisions in the same 29 datasets shown by A2AJ's
current public inventory. Nine are provincial or territorial court datasets:
`BCCA`, `BCSC`, `ONCA`, `NSCA`, `NSSC`, `NSPC`, `NSFC`, `NSSM`, and `YKCA`.
They contain 108,698 local decisions. The prior 15,000-case Luna cohort did
touch all 29 datasets; the remaining provincial problem is representative
coverage and historical roster depth, not missing runner configurations.

CourtListener is the closest reusable structural baseline, and Beaver already
imports its cluster/opinion split plus raw author and joiner strings. Its
opinion types remain source observations: `lead` is not necessarily majority,
and a generic concurrence does not establish agreement in reasons. CAP adds the
useful discipline of keeping upstream renditions, hashes, and corrections
separate. Neither project supplies exact source-text opinion boundaries,
partial/result-only joins, passage voice, or occurrence-level Canadian
treatment; those are the narrow extension layer this experiment must test.

Official roster coverage is strongest for SCC, BC, Ontario, FCA, FC, and TCC.
Nova Scotia's consolidated page and the IRB member list are current snapshots,
not historical appointment records. Nova Scotia and federal Orders in Council
are the reusable historical sources. CMAC biographies contain court-specific
appointment dates. YKCA draws candidates from BCCA and northern superior
courts, while NSSC judges are ex officio NSCA candidates; neither fact proves a
judge sat in a particular case. OHSTC has no official consolidated roster found,
so its A2AJ `Decision-makers` and signatures remain the best positive evidence.
`RPD` and `RLLR` are one adjudicative body with two dataset aliases.

The Federal Organizations pages expose both original and current appointment
dates. The original date may describe membership in the broader organization;
only the current appointment date supports the displayed role or division.
Current/name-only lists are stored as point-in-time roster observations rather
than fabricated open-ended service intervals. Registry misses remain warnings,
never proof that a named adjudicator could not sit.

## Luna-high 15,000-case dispatch and parser throughput (2026-08-17)

The authorized Luna-high cohort uses seed `1783814219`. Its manifest contains
15,000 unique deterministic-unresolved decisions across all 29 A2AJ datasets,
excludes every document in the earlier 30,000-case manifest, and caps one-shot
source packets at 400,000 characters. The active run is
`luna-high-rich-v3-needs-llm15k-seed1783814219-w10-r1`: ten independent,
ephemeral `codex exec` processes, one decision per worker dispatch, with compact
receipts persisted after every case.

An initial launch without network scope was stopped after 85 local transport
failures and retained under the same basename without the `-r1` suffix. Those
are not Luna outcomes and are not included in the active run. The relaunched
progress stream shows successful API responses with the strict
`a2aj_opinion_votes` response schema and no socket-access failures.

The deterministic screen cold path was also replaced. It now reads candidate
IDs from the existing covering `(doc_type, dataset)` index, batch-loads source,
persists source character counts, and derives independent cases in ten child
processes. Within each case, word offsets are indexed once and reused for
boundary word counts instead of repeatedly rescanning text prefixes; a loaded
case also reuses its parsed header rather than deriving it twice.

| Cold screen | Cases examined | Unresolved selected | Wall time |
| --- | ---: | ---: | ---: |
| Prior serial path | 1,327 | 1,000 | 69.87 s |
| Indexed, 10-process path | 1,408 | 1,000 | 13.24 s |

The optimized cell retained all 29 datasets in its 1,000 selected cases and
passed the exact-boundary behavior suite.

### Deterministic hot-path optimization

The parser and screen were profiled again after the 15,000-case launch. The
retained implementation now creates one line index per decision, creates the
source-word offset index only when an opinion candidate exists, uses binary
offset lookup and set membership for range work, and advances through opinion
starts monotonically during vote derivation. Main-process source loading was
removed from screening: each persistent child receives only document IDs and
small metadata, then reads and compiles its own cases once through the existing
bulk primitive. This removes both the large IPC serialization and the former
second SourceDoc compilation in the worker.

On seed `1783814219`, the current cold 1,000-result screen completed in 8.13
seconds. The complete cold 15,000-result screen examined 26,312 randomly
ordered decisions and completed in 51.33 seconds. Candidate metadata and
random-order construction consumed only 0.81 seconds of that total; the
balance is parallel SourceDoc compilation and exact parsing. The original
15,000 manifest screen ran from 19:13:41 to 19:43:12 (about 29.5 minutes), so
the same class of operation is now roughly 34 times faster and no longer has a
serial source/parse stage.

An 8,320-case before/after corpus comparison found zero routing or opinion-count
differences from the performance refactor. A subsequent calibrated fallback
check deliberately changed four BCSC cases: each had promoted a 40--79 word
caption/front-matter block through the weak sole-panel fallback. The fallback
now requires 80 substantive words while explicit ranges and author-marked
opinion bodies retain the general 40-word floor. `2004 BCSC 353` moved from a
false deterministic-ready result (a 46-word caption beginning at offset zero)
to the Luna route, and the behavior has a direct fixture.

### Deterministic v5 stopping point

The retained v5 changes are structural rather than case-specific. Reported
judge speech is no longer treated as a new opinion, title-only names are
discarded, a middle initial `J.` followed by a surname is not treated as a
judicial suffix, and a parsed author who conflicts with a nonempty parsed panel
forces Luna review. Older SCC `judgment of [bloc] ... delivered by` reports now
separate the writer on the next line from the judges who joined that judgment;
an OCR mismatch between the writer and the named bloc also routes to Luna.

The final check reused the 662-document challenge set selected from anomalies
in the earlier 15,000-case audit. It completed in 2.42 seconds at eight workers:
409 cases remained deterministic-ready and 253 were conservatively routed to
Luna. Among those 409, the audit found no reported-speech author evidence,
generic panel member, or author-versus-panel conflict. This is a targeted
regression set, not an estimate of corpus-wide accuracy or coverage.

Further deterministic work should be limited to explicit document grammar,
exact source anchoring, registry-backed identity checks, and contradiction
detection. Implicit authorship, damaged or incomplete panel lists, quoted or
recounted voices without structural markers, and non-explicit voting alignment
belong in the Luna path. New rules require a recurring cross-dataset error
class and a fixture; isolated lexical variants are not enough.

### Live rejection audit and v4 corrections

At the 626-receipt checkpoint, the active immutable v3 cell had 427 accepted
and 199 rejected submissions; all model processes returned code zero. The
largest rejection class was 54 short but exact boundary anchors. The next
largest systematic class came from dotted appellate suffixes: the validator
tokenized `J.A.` as `j`, `a` but failed to ignore `a`, collapsing names such as
`Sharlow J.A.` and `Chipman, J.A.` to the same key.

The v4 prompt/validator now:

- expands a unique short start anchor rightward, or a unique short end anchor
  leftward, while preserving the submitted exact boundary offset;
- keys dotted judicial suffixes by surname;
- normalizes a sole substantive opinion to `lead` and derives its participating
  judges as majority;
- excludes judges explicitly said to have taken no part;
- rejects institutional panel-description tails such as `Employment Board`;
- trims appearances, counsel, solicitor, and non-participation metadata from
  the substantive opinion body; and
- records every exact, untruncated model response in progress and compact
  receipts, for both accepted and rejected outcomes, and links every progress
  event to its document and citation.

Two real-corpus checks closed the motivating failures. `2012 SCC 18` now lists
Binnie and Charron JJ. as nonparticipants rather than majority joiners, and its
opinion ends at “Appeal dismissed with costs” rather than after the solicitor
list. `2019 FPSLREB 62` now has only Nancy Rosenberg on the deciding panel and
routes deterministic-ready instead of requiring a fictitious `Employment
Board` vote.

### Completed 15,000-case rejection replay (2026-08-19)

The interrupted `-r1` dispatch had actually completed all 15,000 cases: 9,751
were accepted and 5,249 were rejected by the frozen v3 validator, with no
missing cases, duplicate receipts, malformed receipts, or execution failures.
Replaying every rejected schema submission locally against v4, without new
model calls, produced:

| Frozen v3 rejection outcome under v4 | Cases | Share of v3 rejections |
| --- | ---: | ---: |
| Salvaged | 4,290 | 81.7% |
| Still rejected | 649 | 12.4% |
| Submission unavailable | 310 | 5.9% |

Among the 4,939 replayable rejections, v4 salvaged 86.9%. The original 5,249
count was therefore primarily a validator result, not a Luna failure rate.

The 649 residual cases contain 1,419 validation messages. After suppressing
secondary vote errors caused by an already-invalid opinion, the largest
overlapping case families are: 193 below the 40-word floor, 122 missing a
deterministically asserted panel member, 112 missing a start anchor, 101 using
an `unknown` placeholder, 82 missing an end anchor, and 61 with vote/alignment
coherence errors. Seventy-two of the placeholder cases are also below the
length floor. Of all 193 length failures, 77 contain fewer than ten substantive
words; repeated examples are “The appeal was withdrawn” and “There is no
document available for this decision.” The strict v3 schema required at least
one opinion and one judge, so it forced Luna to fabricate an opinion-shaped
answer for records that have no extractable opinion. A future schema must make
that outcome explicit instead.

The deterministic panel assertion is also not yet a trustworthy rejection
oracle. Its frequent alleged omissions include `PROTHONOTARY` (13),
`Stephan J.` (13, parsed from Stephan J. Bertrand), `The Honourable Justice
Robert J.` (9), `Prothonotary` (8), `Justice J.` (4), `Adjudicator` (3), and
`Esquire` (3). These are title fragments and header noise, not reliable missing
votes. Similarly, the 61 `mixed` coherence failures are dominated by sole
tribunal members deciding several claimants with mixed outcomes; Luna used
`mixed` for the disposition, while the opinion-vote contract means a sole
decider still authored the lead/majority reasons.

Residuals are concentrated in CITT (129), SCC (83), ONCA (76), FC (45), RAD
(44), and FPSLREB (44). CITT is dominated by forced placeholders and tiny
withdrawal notices. ONCA is dominated by below-floor spans that need sampling
before the threshold changes. SCC's rate cannot yet be treated as
representative because 213 of the 310
unavailable historical submissions are SCC cases.

The replay exposed a receipt-contract defect: the historical v3 cell did not
guarantee storage of the exact model response. Later rejected receipts retained
the parsed schema object, but 310 earlier rejections could not be reconstructed
from their truncated progress preview. The initial V4 fix duplicated each raw
answer in progress and the terminal receipt. The current runner instead writes
it once to the durable output ledger before validation and places its hash in
progress and accepted or rejected receipts.
`analyze_revalidation.mjs` regenerates the ignored per-case/dataset/error-family
analysis from the receipt and revalidation JSONL streams.

### Offline oracle comparison and resumable parallel audit

The v2 deterministic audit accepts either full run JSON or compact receipt
JSONL. It verifies the frozen source hash and compares a frozen model result
directly with the current deterministic oracle for exact text/hash boundaries,
derived paragraph roles, and judge votes. On the known oracle-ready SCC cell,
all 30 frozen Luna-high receipts matched their source hashes and all 30 matched
the oracle paragraph partition. Exact-text and rich-vote comparisons are null
or unequal for that historical cell because its old schema never recorded the
new offsets or relationships; the audit reports that limitation rather than
manufacturing equivalence.

The corpus audit now uses the same true ten-process parser pool as manifest
screening. A 1,000-case, 29-dataset audit completed in 9.20 seconds and wrote
exactly 1,000 durable JSONL results. Re-running with `--resume` completed in
1.2 seconds, retained the same counts, and appended no duplicate results.

## Exact-boundary router and broad audit (2026-08-17)

The v3 extractor replaces paragraph partition as the primary contract. It
records substantive opinion bodies as exact source `[start, end)` offsets and
text hashes, then derives paragraph intersections when a spine exists. Judge
rows separately record result side, relationship to reasons, and opinion IDs.
BCCA front-matter labels, `I AGREE` signatures, numbered joinders, and short
terminal orders no longer become extra opinions. A sole unopposed opinion is
the lead opinion and its panel is majority rather than unknown.

Two local, non-metered audits were preserved under ignored `runs/` output:

| Audit | Cases | Deterministic ready | Route to Luna |
| --- | ---: | ---: | ---: |
| Frozen partial Luna-low receipts | 12,315 | 8,538 | 3,777 |
| Stratified 30 per A2AJ dataset | 869 | 205 | 664 |

The frozen cohort covered nine early corpus datasets and exposed the prior
run-order defect: random membership had been sorted by document offset before
dispatch. The first 12,315 receipts were therefore dominated by BCCA (1,995)
and BCSC (7,029). Seeded draws now retain pseudo-random order.

The deterministic router resolved 561/644 old
`secondary_judge_without_secondary_opinion` cases locally, 899/1,449 old
all-unknown judge cases, 210/293 schema rejections, and 17/23 one-paragraph
secondary-opinion cases. It routed 663/687 cases previously blocked by missing
paragraph structure back to Luna, because exact text offsets no longer require
a paragraph spine but no reliable local opinion boundary was found.

The broad audit sampled 30 cases from each of all 29 eligible A2AJ datasets
(PSDPT contains 29 eligible cases). Routing varied materially: BCCA was 20/30
ready, BCSC 22/30, FC 27/30, TCC 26/30, and YKCA 25/30; numerous tribunal and
administrative datasets were 0/30 ready. Overall, 664/869 (76.4%) warranted
Luna, confirming that the richer model path must remain first-class.

## Luna high vs low, random 30-case screen (2026-08-15)

- Seed: `285949255`
- Model: `gpt-5.6-luna`
- Ordered cohort: 30 A2AJ decisions, identical across efforts
- High receipt: `runs/luna-high-random30-seed285949255.json`
- Low receipt: `runs/luna-low-random30-seed285949255.json`
- Paired comparison: `runs/luna-high-v-low-random30-seed285949255.json`

| Measure | High | Low |
| --- | ---: | ---: |
| Accepted extractions | 23/30 | 24/30 |
| Rejected model submissions | 2/30 | 1/30 |
| Structure unavailable before model call | 5/30 | 5/30 |
| Accepted per actual model call | 23/25 (92%) | 24/25 (96%) |
| Model-call wall time, total | 195.15 s | 145.42 s |
| Model-call wall time, median | 6.95 s | 5.49 s |
| Input tokens | 496,945 | 496,920 |
| Output tokens | 5,817 | 2,882 |
| Reasoning output tokens | 4,416 | 1,471 |

Among the 23 cases accepted by both efforts, the complete span partition was
identical in 14 (60.9%), the judge-role set was identical in 13 (56.5%), and
mean paragraph-role agreement was 60.9%. Nine of the ten disagreements assigned
the entire decision to `majority` in one run and `unknown` in the other. The
remaining disagreement (`2020 YKCA 6`) kept the same all-majority paragraph span
but differed on whether two panel members were majority or concurring.

This cohort cannot measure accuracy: the deterministic partition reported
`ready` for 0/30 cases, so no model result received an oracle score. Five cases
had no canonical paragraph spine and were never sent to Luna. The next quality
cell should sample randomly from cases whose deterministic reference is ready,
then hold those IDs fixed across efforts. The present cell remains useful as a
transport, schema-compliance, latency, token-use, and effort-sensitivity screen.

High rejected `2012 BCSC 2199` and `2009 ONCA 867` because submitted judge-name
forms did not pass exact source-header validation. Low rejected only
`2012 BCSC 2199` for the same reason.

## Parallel Luna high vs low, oracle-ready SCC 30 (2026-08-16)

- Fixed cohort: 30 cases whose deterministic partition reference was `ready`.
- IDs came from `runs/oracle-ready30-scc-seed923234369.json` and were held in
  the same order for both efforts.
- Each case used its own ephemeral Codex exec; the dispatcher ran 8 workers,
  one case per worker dispatch. The receipts report
  `dispatch: one-case-per-ephemeral-codex-exec` and `workers: 8`.
- The extraction payload used the strict GPT Responses-style JSON Schema
  `a2aj_opinion_roster`; the full schema is embedded in each receipt and the
  Codex output-schema file was derived from the same object.
- High receipt: `runs/luna-high-oracle-ready30-scc-seed923234369-w8.json`
- Low receipt: `runs/luna-low-oracle-ready30-scc-seed923234369-w8.json`
- Paired comparison: `runs/luna-high-v-low-oracle-ready30-scc-seed923234369-w8.json`

| Measure | Luna high | Luna low |
| --- | ---: | ---: |
| Accepted extractions | 30/30 | 29/30 |
| Deterministic span exact | 30/30 | 28/30 |
| Deterministic paragraph-role mean | 1.0000 | 0.9997 |
| Model-call wall total (sum of case calls) | 348.34 s | 250.73 s |
| Dispatch wall (8 workers) | 60.65 s | 35.39 s |
| Input tokens | 990,893 | 991,415 |
| Output tokens | 12,584 | 7,618 |
| Reasoning output tokens | 8,036 | 3,154 |

Among the 29 cases accepted by both efforts, the complete span partition was
identical in 28 (96.6%), judge-name/role sets were identical in 13 (44.8%),
and mean paragraph-role agreement between efforts was 99.97%. The remaining
judge disagreement is mostly canonical-name formatting and role labels for
panel members; the deterministic span oracle is not affected. Low's one
rejection was `2005 SCC 41`.

The progress stream confirms the concurrency contract: all first eight
`case_started` events share the same timestamp, and each completed worker is
immediately assigned the next single case. The final receipt restores cases to
input order for later checking.

## Corpus-scale Luna-low preparation (2026-08-16)

The runner now supports corpus-scale execution without holding the completed
cohort only in memory:

- `manifest` writes a reproducible random cohort with seed, scope, IDs, and
  case metadata.
- `--receipt-mode compact` appends one compact boundary receipt per completed
  case to `.receipts.jsonl` immediately after its sidecar row is saved.
- `--resume` reads that stream and skips already completed document IDs.
- The final JSON points to the receipt stream instead of duplicating tens of
  thousands of full per-case objects.

Prepared manifest: `runs/luna-low-all-30k-seed2006245071.manifest.json`.
It contains exactly 30,000 unique eligible `ALL`-scope case IDs. The user
authorized the expanded metered/data-egress scope on 2026-08-16, and the
detached run is active with `gpt-5.6-luna` at low effort and eight workers.
Receipts are being written to
`runs/luna-low-all-30k-seed2006245071.receipts.jsonl`; progress is in the
adjacent `.progress.jsonl` file. At the latest checkpoint recorded here,
7,922 cases were complete (7,622 accepted, 232 rejected, 75
structure-unavailable, zero execution failures). The final JSON receipt will
be written only after all 30,000 cases finish.

## Combined semantic MVP, diverse 15 (2026-08-19)

- Frozen cohort: `semantic-mvp-15.json`, one seeded-random qualifying case from
  each of 15 datasets, with two sampled citation contexts per case.
- Run: `runs/semantic-mvp-15-luna-max-v2.json`; raw final answers and exact
  streamed Codex events are in the adjacent `.outputs.jsonl` file.
- All 15 receipts report `gpt-5.6-luna` at `max`, distinct thread IDs, and
  return code zero. Ten workers dispatched one ephemeral exec per case. One
  WebSocket reset retried successfully.

| Measure | Result |
| --- | ---: |
| Fully accepted combined records | 3/15 |
| Opinion/vote extraction accepted | 13/15 |
| Issue cards accepted by exact grounding checks | 47/60 |
| Accepted substantive treatment events | 25 |
| Accepted direct-history events | 0 |
| Input tokens | 433,705 |
| Output tokens | 284,791 |
| Reasoning tokens | 234,050 |
| Median case latency | 484.26 s |
| Maximum case latency | 684.53 s |
| Dispatch wall time | 17.2 min |

The three fully accepted decisions (`2002 BCCA 3`, `2005 FC 894`, and
`2016 CHRT 18`) produced coherent issue questions, answers, bases, and exact
evidence. Across the 25 grounded treatment events, attribution was
`current_court` 7, `quoted_authority` 10, `party_submission` 4,
`reported_decision` 3, and `procedural_recounting` 1. That separation is doing
real work: most citation language in this cell should not become controlling
court treatment. The noisy CITT date-like citation candidates yielded no
substantive treatment.

The two opinion-layer rejections were narrow grounding failures: one opinion
had both a named author and a collective author; one FCA decision used repeated
bare judge-name anchors that could not be resolved uniquely. Of the 13 rejected
issue cards, failures were missing exact quotes or evidence outside the card's
own discussion span. Seven selected citation occurrences fell outside every
resolved opinion, and seven treatment events used evidence outside the sampled
occurrence's context. The former is mostly a candidate-selection/eligibility
problem; the latter shows the model drifting from the requested occurrence to
another discussion of the same authority.

An initial canary exposed that the runner buffered Codex JSON events until
completion, hiding sandbox network failures. It now appends every exact raw
event immediately and writes a content-free progress summary alongside it.
The next context ablation is recorded in `PLAN.md`: closed-record,
later-judgment characterization, journal characterization, and combined arms,
with every external characterization kept separate and provenance-tagged.

## Case-target prompt ablation, flat-subscription baseline (2026-08-20)

The controlled case-target cell uses 15 frozen citing-decision/target pairs:
five directly reviewed human-development cases and ten untouched holdouts. Each
call sees the complete citing decision, one fixed target identity, and every
deterministically resolved target occurrence. The target decision itself is
not context in this cell.

The live transport now uses the existing ChatGPT/Codex subscription adapter at
`https://chatgpt.com/backend-api/codex`, with `auth_mode=chatgpt`; API-key
environment variables are removed in every child. Each case has an isolated
process, ten logical calls run concurrently at BelowNormal priority, decoded
provider events are appended as they arrive, and the exact final answer is
stored separately. The parent retains only a streaming hash and the small
start/completion receipts. A local 17 MiB stream test and this 44 MiB baseline
raw stream both completed beyond the retired 16 MiB buffer limit.

One baseline canary (`2014 CART 21`) completed in 723.25 seconds with 5/5
mentions, 2/2 issue positions, and one controlling `applied` treatment. The
same frozen case in the baseline run also found an attributed `explained` event
and an issue-scoped `distinguished` event. Both runs passed structural
validation; the difference is useful evidence of semantic run variance and is
not resolved by validator survival.

Baseline arm: `runs/case-target-prompt-baseline-luna-max-flat-sub-v1.*`.
Revalidation uses validator v10.

| Measure | Baseline |
| --- | ---: |
| Opinion extraction accepted | 12/15 |
| Whole case-target record accepted | 6/15 |
| Partial semantic salvage | 6/15 |
| Opinion-layer rejected | 3/15 |
| Opinion positions accepted/submitted | 59/65 |
| Target mentions accepted/submitted | 20/22 |
| Treatment events accepted/submitted | 11/16 |
| Direct-history events accepted | 2 |
| Input tokens | 145,076 |
| Output tokens | 573,082 |
| Reasoning tokens | 514,863 |
| Median logical-call latency | 809.23 s |
| Maximum logical-call latency | 1,509.09 s |
| Ten-worker dispatch wall | 29.63 min |
| Provider retries | 4 |

The three opinion rejections were narrow, auditable inconsistencies: a repeated
author-link quote, an author link absent from `author_names`, and two
result-only evidence quotes that did not identify their judges. Partial
semantic failures were primarily evidence outside the resolved opinion or
discussion span, orphaned issue links, and treatment/mention linkage errors.
All submitted raw subrecords remain available for later deterministic salvage.

On the five human-development cases, the baseline treatment labels agree on
the central `applied` result in three cases and on the direct `reversed` history
in one. The remaining ONCA case produced `distinguished` plus `limited` where
the human annotation recorded `distinguished` plus `questioned`; that is a
semantic grading question for Sol Max, not a deterministic correction. No
prompt is selected until all four frozen arms and blinded grading complete.

The verbose arm (`runs/case-target-prompt-verbose-luna-max-flat-sub-v1.*`)
improved the local gate to 13/15 opinion-valid and 7/15 fully target-valid. It
accepted 62/65 positions, 21/21 mentions, 13/17 treatments, and two direct
history events. Median latency was 637.03 seconds, maximum latency 878.19
seconds, and ten-worker wall time 25.52 minutes. It used 146,561 input, 527,425
output, and 471,891 reasoning tokens, with no provider retry.

That structural lead is not yet a semantic win. On human cases, verbose found
the annotated `questioned` plus `distinguished` ONCA treatments that baseline
rendered as `limited` plus `distinguished`, but it changed C28760 from the
human-annotated `applied` to `referred_to`. This is exactly why arm selection
uses human/Sol adjudication rather than acceptance counts alone.

The concise arm (`runs/case-target-prompt-concise-luna-max-flat-sub-v1.*`)
regressed sharply: 9/15 opinion-valid and 1/15 fully target-valid. It accepted
41 opinion positions, 20 target mentions, only 2/18 submitted treatments, and
one direct-history event. Median latency was 736.79 seconds, maximum latency
1,456.13 seconds, and ten-worker wall time 34.14 minutes. It used 125,377
input, 516,966 output, and 462,365 reasoning tokens, with three provider
retries.

Most concise treatment failures supplied a generated characterization where
the frozen contract required source-grounded proposition text. One BCSC call
returned an empty final answer after a complete provider event stream. The
JSONL itself contained 68,894 valid records and no corrupt line; the offline
readers were corrected to retain that case as a fail-closed model rejection
instead of aborting revalidation of the arm.

## Prompt selection, validator v12, and repair canary (2026-08-20)

The exact four-arm cohort is now durable in
`case-target-prompt-cell-15.json`. It contains the five human-development pairs
and the same ten blind holdouts used by every arm. The launch manifest had not
been retained; the replacement was recovered from the per-case receipts,
which preserved the source document, target identity, aliases, and corpus ID.

Validator v12 incorporates the generalizable defects found in the runs:
normalized target propositions are separate from exact treatment evidence;
all deterministic target occurrences must be accounted for; citation-only
endnotes can link to an unambiguous inline marker; exact containment can repair
wrong model-supplied opinion IDs; and an explicit `REASONS ... BY: JUDGE`
byline overrides a contradictory collective-author label. Replaying the four
unchanged output streams gives:

| Luna Max arm | Opinion-valid | Whole target-valid | Positions | Mentions | Treatments | Direct history |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 13/15 | 7/15 | 60/66 | 22/24 | 13/18 | 3 |
| Verbose | 14/15 | 9/15 | 63/66 | 22/22 | 15/18 | 3 |
| Concise v2 | 12/15 | 7/15 | 56/67 | 10/17 | 8/16 | 4 |
| Examples v2 | 14/15 | 10/15 | 65/74 | 18/27 | 12/19 | 3 |

The selected examples packet regenerated the exact stored prompt SHA-256 for
`2007 FC 676`; the later FCA byline lesson remains a deterministic
normalization and did not silently create an untested prompt version.

Every live extraction and grade used the Codex/ChatGPT flat-subscription
endpoint, `auth_mode=chatgpt`, with API-key variables removed. All cases used
isolated one-case processes, ten-worker extraction dispatch, and BelowNormal
priority. The shared ledger now records 315 attempted submissions including
the 97-call carry-forward and 19 provider retries; 14,685 of the authorized
15,000 remain.

Sol Max graded the current examples and concise repeats against the five
direct annotations. Examples was usable on 5/5; its mean issue recall,
precision, and answer correctness were 4.0/4, treatment label accuracy was
3.8/4, and treatment scope and authority side were 3.6/4. Concise was usable
on 2/5, with means of 2.8, 3.0, and 3.2 for issue recall, issue precision, and
answer correctness. Across both human-case runs, examples was usable on 10/10
and concise on 7/10.

The ten-case blind comparison was less decisive. Concise was usable on 5/10
and preferred in five cases; examples was usable on 4/10 and preferred in two.
Examples nevertheless had higher mean treatment (3.1 versus 2.5), occurrence
attribution (3.5 versus 2.9), and opinion authority (4.0 versus 3.2). Baseline
was usable on 4/10 and verbose on 3/10. Given the stated priority order and the
concise repeat's instability on the human cases, examples v2 is the provisional
MVP prompt. Applied/followed/approved remain too fine for an unqualified
inference-time flag; the derived relied-on family is the safer compact value.

The CIRB repair canary used provider-enforced JSON Schema through the Beaver
Codex app-server. Its initial examples extraction failed seven linked-record
checks. Same-thread validator feedback repaired six and left one error: a
treatment linked issue `i3` without a linked mention carrying `i3`. A fresh
full-context correction returned malformed JSON. The persistent turn also
consumed 47,971 input tokens versus 14,008 initially and reported no cache
read. Automatic repair is therefore not part of the MVP; the result supports
a smaller future test of targeted machine-edit operations rather than another
full extraction turn.

Three current concise calls ended empty after the subscription stream reset
twice. Full stderr is now retained in the raw stream and hashed/sized in compact
receipts. All three show `httpx.RemoteProtocolError` from an incomplete chunked
response, separating transport loss from schema or semantic rejection.

## Provisional MVP viability review (2026-08-20)

The attempted 4,950-pair scale run was stopped after 6.1 minutes. Its exact
36-process tree was terminated without touching unrelated processes. The run
used 12 ledger attempts across ten source decisions, produced no completed
model answer, and retained 5.57 MiB of raw partial events plus one interruption
failure receipt. It is excluded from quality rates. The append-only ledger has
327 attempted submissions: 97 carried forward, 209 started calls, and 21
provider retries. Thus 14,673 of the authorized 15,000 remain. Future runs use
five workers.

The useful evidence already spans three different cells and should not be
pooled as one percentage:

- The seeded 50-case calibration covered all 29 A2AJ datasets. After replacing
  its 19 sidecar failures with the dedicated retry, the older v2/v3 prompts
  produced 36/50 opinion-valid and 16/50 whole target-valid records, accepting
  155/181 opinion positions, 55/70 target mentions, and 37/51 treatment events.
- The current examples-v2 prompt on the fixed 15-pair cell produced 14/15
  opinion-valid and 10/15 whole target-valid records, accepting 65/74 opinion
  positions, 18/27 mentions, 12/19 treatments, and three history events.
- Against five hand-written case records, Sol Max found all five examples-v2
  outputs usable. Issue recall, issue precision, and answer correctness were
  4.0/4. Four treatment records had no substantive treatment error. In `2014 CART 21`,
  Luna improperly grouped a reported/quoted explanation with the Tribunal's
  own application, omitted the separate attributed explanation, and scoped
  the controlling application too narrowly. One other record understated a
  threshold jurisdiction ruling as non-dispositive.

The ten untouched holdouts are a warning against extrapolating from the five
development cases. Sol Max called only 4/10 examples-v2 records semantically
usable, although their mean scores remained strong for opinion authority
(4.0/4), occurrence attribution (3.5/4), and treatment (3.1/4). The broad
50-case cell used older prompts, while the current 15-case cell is not an
opinion-structure stress set. None of the retained parsed predictions in those
65 cases contained more than one opinion. A separate semantic-MVP SCC decision,
`[1979] 2 SCR 529`, did
correctly recover two opinions, the six-judge majority, the three-judge
dissent, and distinct issue positions, but that is only one direct test of the
hard case. Partial joinders and issue-specific judicial coalitions therefore
remain unproven.

### Capability assessment

Luna Max is already useful for a selectively run, fail-closed enrichment
pipeline. On ordinary single-opinion decisions it usually finds the writer and
panel relationship, frames the decided issues, states the answer, grounds it in
the current court's words, accounts for known target occurrences, and separates
court speech from counsel, quotations, reported decisions, and procedural
recounting. The current schema can represent the information the MVP needs,
including different answers by opinion and a compact issue-aware treatment
projection.

It is not ready to supply inference-critical treatment claims without receipts
and filtering. Fine labels such as `applied`, `followed`, and `approved` are
less stable than the broader relied-on family. Multiple mentions can still be
collapsed across speaker contexts. Exact-quote mistakes and one bad issue link
can cascade through an otherwise useful record. Result-only panel evidence is
too awkward for collective tribunal decisions. Current latency is also an
offline-enrichment profile: examples-v2 used a 701-second median and 545,696
output tokens for 15 calls, of which 486,981 were reasoning tokens.

The judge-service registry is not yet part of this quality result. The current
live-check snapshot is a partial 123-person artifact, these MVP runs did not
pass it, and the implemented runner presently attaches resolutions to receipts
rather than giving vetted candidate names to Luna or using them in validation.
Its proposed benefit to authorship and quoted-judge disambiguation therefore
needs its own controlled roster-hint test; it should not be silently combined
with the schema ablation.

The ontology should be retained, but the model-facing contract should be made
smaller. The next schema ablation should:

1. nest semantic records and assign bookkeeping IDs deterministically instead
   of asking Luna to generate and cross-link them;
2. remove model-declared issue hierarchy and discussion boundaries from the
   MVP, retaining exact answer/basis evidence and deriving conservative evidence
   ranges and paragraph views after quote resolution;
3. derive occurrence identity, offsets, opinion containment, judge-by-issue
   counts, and flat treatment families locally;
4. keep a normalized target proposition distinct from verbatim treatment
   evidence, and allow a treatment to remain proposition-scoped but
   case-issue-unscoped rather than forcing an invented issue link; and
5. keep detailed treatment labels in the auditable graph while exposing only
   `relied_on`, `declined_or_constrained_on_issue`, `explained`,
   `mentioned_only`, and `direct_history` families to cheap downstream routing.

The MVP is viable as audited selective enrichment, not yet as a corpus-scale
citator. The next evidence-producing step is a paired current-schema versus
reduced-schema Luna Max test on 15 deliberately difficult decisions: five true
multi-opinion or partial-join cases, five attribution traps, and five ordinary
court/tribunal controls. Use five isolated workers, grade every case with Sol
Max, and hand-inventory five. Only after that schema choice should the combined
versus structure-first, roster-hint, and citing-only versus
citing-plus-target-text ablations run.

## Nested v13 canary and v14 replacement (2026-08-20)

The frozen v13 Luna Max canary ran five difficult case-target pairs: two
multi-opinion/partial-join cases, two attribution traps, and one ordinary
control. All five calls used separate flat-subscription processes and retained
raw event streams and exact final answers. Three of five opinion records were
valid; one target graph was wholly valid, two retained useful locally accepted
target material, and two failed at the roster boundary. The calls used 79,904
input tokens, 193,830 output tokens, and 177,160 reasoning tokens. Median
latency was 764 seconds.

The failures were structural rather than evidence that the ontology was too
rich. Luna supplied additional case-name mentions itself, allowed one bad
optional basis quote to invalidate useful positions, repeated a partial join
for a judge who had written a position, treated an ONCA panel roster as a
collective author, and missed otherwise exact boundary or panel text by a few
characters. The accepted NSCA result correctly separated a party's Sattva
submission from the court's own limitation. The SCC and YKCA outputs recovered
multiple independently reasoned bodies and issue-specific positions.

V14 removes those avoidable failure classes from the model contract:

- the host registers citation and conservative case-name occurrences and Luna
  references only supplied occurrence IDs;
- the harness assigns all other IDs, offsets, ordering, containment, paragraph
  views, and flat treatment families;
- bad optional basis evidence is rejected locally without discarding the
  grounded opinion position;
- redundant partial joins are rejected locally;
- a panel roster cannot be a collective author; and
- conservative boundary-prefix/suffix recovery is separately receipted.

The citing decision remains byte-for-byte and appears once in the prompt. On
the 15-case challenge set, non-source packet material is 3,202-5,249
characters and the structured-output schema is 7,699 characters. The prior
pathological 11,749-character case disappeared after removing unsafe aliases,
preflight dumps, hashes, and repeated object keys.

Historical recompilation now bypasses corpus structure derivation entirely.
It loads each decision by document ID, verifies its frozen source, panel, and
occurrence receipts, and grounds the retained answer in memory. The five-case
pass fell from 16.16 seconds to 483.8 ms, made zero model calls, and emitted
five immutable canonical receipts. It reproduced the 3/5 opinion-valid result.
Its 0/5 v14 target-valid count is not a v14 model score: the retained v13 raw
answers contain the deliberately removed model-authored mention shape, and no
compatibility converter was added. A fresh v14 call is the honest test.

Local gates pass: 34 focused treatment/semantic/target compiler tests, the
runner self-test, the backend TypeScript build, and all 15 human-gold records.
The human gold now lives as three tracked experiment artifacts rather than
ignored scratch output.

## V14 live canary and v15 offline recovery (2026-08-20)

The first v14 dispatch was accidentally run inside a network-restricted
sandbox. All five isolated processes failed at the socket boundary with
`WinError 10013`; they produced no provider answer and are excluded from model
quality, although their five attempted submissions remain in the conservative
ledger. The escalated rerun used Luna Max, five isolated BelowNormal workers,
one case per process, and retained every event and raw answer.

Three cases returned complete schema JSON. Two long cases, `2020 SCC 32` and
`2018 NSCA 53`, timed out after 1,205 seconds; their provider streams and one
retry each are retained, but they provide no semantic result. The three final
answers were:

- `2025 ONCA 336`: the model correctly left individual authorship unknown,
  identified the three-member panel and nonparticipant motion judge, recovered
  the disposition, and applied `2021 ONCA 364` for the review test. V14 rejected
  only because Luna added the unsupported optional label `the panel` as a
  collective writer. It also split the governing review test from its
  application, where the audited gold treats them as one ultimate issue.
- `2015 YKCA 17`: the model recovered both authored opinions, all three
  participants, six per-opinion issue positions, both target occurrences, and
  both treatments. V14 rejected only first-person partial-joinder evidence that
  lay inside the joining judge's own authored reasons because the quote did not
  repeat her name.
- `2005 CAPPRT 050`: the collective Tribunal, three-member panel, disposition,
  six issue records, all three target occurrences, and three treatment events
  survived. The record remains partial because one whole optional basis has no
  source-grounded evidence. A separate source-only audit identifies five
  ultimate issues, treats the model's bad-faith/arbitrariness split as too fine,
  and classifies the third occurrence as quoted authority rather than the
  current Tribunal.

V15 fixes only general validation and instruction defects. An unsupported
collective-writer claim is dropped to unknown with a warning; it cannot turn a
panel into an author. First-person agreement is accepted when its unique exact
quote lies inside that participant's proved authored opinion and contains an
agreement/joinder cue. A bad extra quote in an otherwise grounded optional
basis becomes a warning; a basis with no valid evidence is still omitted and
keeps the graph partial. The prompt now keeps a governing test and application
together unless separately answered, distinguishes a citation inside quoted
reasons from the current court's introduction, and states the `applied` versus
`followed` distinction.

Recompiling the retained answers under v15 took 407.4 ms and made zero model
calls. It produces 3/5 opinion-valid and 2/5 whole-target-valid records: YKCA
and ONCA are valid; CIRB remains partial for the genuine omitted basis; the two
timeouts remain failures. The focused suite now passes 35/35, the runner
self-test passes, and the backend TypeScript build passes. Ledger usage is 464
attempted submissions including retries and carry-forward, leaving 14,536 of
the authorized 15,000.

## Extraction-v2 challenge-10 result (2026-08-20)

The Luna Max run produced nine structurally valid records from ten cases; one
case failed submission validation. After correcting three gold boundaries that
had included provider headings, all 14 opinion starts and ends in the nine
valid records matched gold exactly. Luna also identified the majority/minority
arrangement in all nine cases, including all four multi-opinion cases, and the
writers in all nine. The complete voting graph was exact in seven: Luna missed
one genuine issue-specific joinder and invented one issue-specific joinder.

The conservative deterministic layer was available for four cases and made 78
scored voting assertions, all correct. Luna supplied 65 of the 66 gold voting
facts outside those assertions. This supports a hybrid design in which
deterministic facts are asserted only when they meet a zero-known-false-positive
gate, Luna fills the abstentions, and deterministic checks reject impossible or
contradictory model output.

Treatment-by-issue performance was not ready for unreviewed corpus-scale use.
Sol Low graded four records pass and five major error. Three valid records
contained semantic hallucinations grounded in real text:

- `2015 YKCA 17`: Luna converted counsel's reliance on the target into a
  separate treatment by the court.
- `2021 CHRT 18`: Luna converted procedural or factual references to the prior
  ruling into three substantive treatment events.
- `2007 FC 971`: Luna confused two Abbott decisions and invented a
  `distinguished` treatment of the target.

The remaining major errors were an omitted issue link in `2007 FCA 24` and an
overstatement of Sattva's treatment in `2018 NSCA 53`. Thus the opinion-boundary,
writer, and majority/minority extraction is promising; treatment attribution,
target identity, and treatment strength still require validation or repair
before corpus-scale promotion. The durable Gold set contains 60 independently
reviewed current annotations; revision narratives are not part of Gold.

# A2AJ decision-roster results

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

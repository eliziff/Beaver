# A2AJ decision-roster experiment

## Goal

Derive auditable substantive opinion bodies and judge voting relationships for A2AJ decisions. Use high-precision deterministic extraction as a local result for opinion-only runs and as an oracle/validator for semantic runs; semantic MVP cases always go to Luna Max. Opinion boundaries are exact source-text offsets with verbatim anchors; paragraph ranges are derived metadata, not the extraction contract.

The experiment must remain siloed from the inflight compaction/tool-structure work. It must reuse the existing A2AJ, `SourceDoc`, lookup, locator, evidence, and SQLite machinery. It must not grow a second family of runners, watchers, caches, bridges, or generated artifacts.

## Current architecture

1. The deterministic extractor recognizes explicit opinion ranges, author-bearing reasons headings, paragraph-start authors, BCCA joinders/signatures, and terminal disposition lines. It emits exact `[start, end)` offsets, boundary anchors, opinion alignment, and per-judge vote relationships.
2. A result is `ready` only when every substantive opinion has an author and alignment and every discovered judge has a result side. A sole unopposed opinion is `lead`; all judges who author or join it are majority, even when the source never uses that word.
3. Opinion-only corpus runs may accept deterministic-ready cases locally. Semantic MVP runs send every frozen case to Luna Max; deterministic output remains a parallel observation and validator, never a substitute for the model's legal/semantic judgment.
4. Luna returns strict schema `a2aj_opinion_votes`: exact disposition and boundary quotes, named or collective authors, participants and nonparticipants, result positions, and evidenced author/joinder links. Validation resolves exact offsets, enforces a substantive-length floor and non-overlap, and verifies name, vote, and opinion-link evidence.
5. Each Luna case gets a distinct child process over the repository's existing Codex ChatGPT-subscription adapter. Runs use a bounded worker pool and persist every decoded provider event plus the exact final answer before validation. Raw answers live once in an append-only `.outputs.jsonl` ledger; progress and receipts retain their hashes. Runs can resume without repeating completed document IDs.
6. Cold deterministic screening reads IDs from the corpus's covering dataset index and fans independent derivations across up to ten persistent child processes. Workers receive only IDs and small metadata, then batch-read and compile their own source once through the existing bulk primitive; full case text is never serialized from the main process. Screen receipts cache source length and routing, so a resumed manifest can sample the qualified cache without reparsing.
7. The resumable audit uses the same ten-process batch pool. With a frozen full JSON or compact JSONL receipt input it source-hash checks each case and compares model output directly with the deterministic oracle for exact text boundaries, derived paragraph roles, and judge votes.

The deterministic layer additionally treats explicit non-participation as exclusion from the deciding
panel, filters institutional tails in tribunal panel descriptions, expands
unique short boundary anchors without moving their offsets, and refuses
reported-speech cues as opinion-author markers.

## V5 extraction and treatment ablation

The V5 Luna contract records exact disposition evidence, opinion boundaries,
named or collective authors, participating and nonparticipating judges, and a
many-to-many author/joinder graph. Code resolves quotes into source offsets and
derives paragraph intersections, result-side majorities, majority/plurality/
concurrence/dissent labels, hashes, and compatibility views.

Opinion authorship is a first-class target, not something inferred from panel
membership or agreement. For each opinion, preserve the source-displayed author
name or collective label, an exact local authorship cue, and whether that cue is
an explicit reasons heading, a delivered-by/byline formula, a signed opinion,
external source metadata, or only an inference. A signature that merely records
agreement is joinder evidence, not authorship. Permit unresolved authorship
rather than forcing a named writer. Resolve a displayed name to a registry
person only after extraction, and retain `unique`, `ambiguous`, or `no_match`
alongside the raw name so later judicial-behaviour analysis does not silently
merge people.

Judge identity may be enriched from a local, source-cited temporal registry of
aliases, courts, service intervals, roles, and permanent or special
assignments. Registry matches are receipt metadata, not model inputs or hard
panel exclusions. A missing match can be an incomplete registry, an ad hoc
sitting, or an ex officio assignment.

Case treatment is an empirical extension of this work, not a predetermined
second stage. The harness must support two paired modes over identical frozen
case-target pairs and deterministic occurrence maps:

1. **Combined:** one Luna call returns opinion/vote structure, shared issues,
   opinion positions, and issue-linked treatment of the named target.
2. **Staged:** the first call returns structure and issues; the second receives
   those resolved records plus the full citing decision and returns the same
   target-treatment contract.

Both modes use the same model, reasoning effort, complete citing source, named
target, target occurrences, and selection order. Compare opinion-boundary and
vote accuracy, shared-issue structure, judge-by-issue support, treatment label,
issue link and evidence accuracy, cross-record coherence, schema failures,
latency, and tokens. Preserve raw output from every call. Do not select the
production mode until the paired results exist.

The next context ablation will rerun the same frozen cases after giving the
model source-cited characterizations of the cited cases from both later
judicial decisions and legal journals. Keep every characterization in a
distinct, provenance-tagged context block; do not append it to the decision
text, convert it into a source-court holding, or use it as a validation label.
Neither judicial nor scholarly characterizations are presumed superior. Run
separate judicial-only, journal-only, combined, and closed-record arms where
coverage permits, because each intervention can improve grounding while also
changing the task through anchoring, temporal leakage, authority-side mixing,
selection effects, and added token cost. Record the snapshot date, source
document, author or court, exact passage, and cited-case link for every
characterization so the context intervention itself is reproducible.

## Open-source baseline and A2AJ roster coverage

Do not invent a second case-law hierarchy. Beaver already imports
CourtListener clusters and opinions. Use that separation as the baseline:

```text
source document -> decision/cluster -> exact opinion spans
person -> dated court position
opinion -> participants and scoped joins
citation occurrence -> resolved citation edge -> treatment assertion
```

CourtListener `type`, `author_str`, `joined_by_str`, panel strings, and citation
edges are imported source assertions. They are not proof that an opinion is a
majority or that a judge adopted all of its reasoning. Extend the baseline only
where the Canadian work requires it: source-hash-bound character spans,
coauthors, partial/result-only joins, unresolved raw judge names, claim-level
evidence, passage voice, and model/deterministic receipts. Use CAP's source
discipline--preserved upstream payloads, separate normalized renditions, hashes,
and corrections--without copying its full database history machinery.

The current A2AJ case corpus has 29 datasets. The nine provincial/territorial
court datasets are `BCCA`, `BCSC`, `ONCA`, `NSCA`, `NSSC`, `NSPC`, `NSFC`,
`NSSM`, and `YKCA`; coverage work must measure those datasets directly, not use
the Luna sample as a proxy. The remaining sources are `SCC`, `FCA`, `FC`, `TCC`,
`CMAC`, `CHRT`, `CIRB`, `CITT`, `CT`, `FPSLREB`, `OHSTC`, `OIC`, `PSDPT`,
`RAD`, `RPD`, `RLLR`, `SST`, `TATC`, `CART`, and `SCT`. `RPD` and `RLLR`
refer to the same IRB division and therefore share one court identity with two
dataset aliases.

The roster snapshot uses CourtListener's person/position/court vocabulary and
keeps exact official-source evidence on every position. A current roster proves
only membership as of retrieval; it does not invent an appointment start date.
Likewise, NSSC judges' eligibility to sit ex officio on NSCA, BCCA judges'
eligibility for YKCA, and other special assignments create candidate pools,
not hard panel membership. Missing registry support never excludes a displayed
judge. Federal Organizations `Original appointment date` describes broad
organization membership; role-specific intervals use the `Current appointment
date` and retain the original date only as separate evidence.

Roster work is admitted source by source. Each adapter has saved HTML fixtures,
parser tests, page URL/retrieval time/content hash, exact supporting text, and a
coverage report by A2AJ dataset and decision year. Historical gaps are filled
from official appointment/retirement releases and Orders in Council where
available. The scraper writes a valid partial snapshot after every page and
never treats a current name-only list as a complete historical registry.

Pass a validated snapshot to a run with
`--judge-service-file <snapshot.json>`. The parent reads and hashes it once;
workers never receive the registry. Full and compact case receipts retain each
raw participant name and its `unique`, `ambiguous`, or non-exclusionary `no_match`
resolution, while run metadata records the local path and snapshot hash.

Treatment stays attached to a resolved citation occurrence and its containing
opinion. Direct appellate history is stored separately from substantive
treatment; party submissions and quoted sources cannot silently become the
court's treatment. A stable citation key permits treatment of a cited decision
that is absent from A2AJ, although target-proposition alignment then remains
unavailable until that decision is acquired.

Seeded samples preserve pseudo-random draw order rather than sorting by document ID. A filtered manifest can prequalify an exact number of deterministic-unresolved cases while excluding an earlier manifest:

```powershell
node experiments/a2aj_decision_roster_qwen/harness.mjs manifest `
  --needs-llm --seed 123 --sample-size 15000 --scope ALL `
  --exclude-case-file experiments/a2aj_decision_roster_qwen/runs/earlier.manifest.json `
  --out experiments/a2aj_decision_roster_qwen/runs/luna-high-needs-llm15k.manifest.json
```

The screen starts with an interleaved sample from every eligible A2AJ dataset, then fills from the global seeded random order. Screening is local, resumable, ten-process by default, and makes no model calls. Use `--workers` to lower its process bound.

## Issue, authority, and treatment utility experiment

### Current MVP: one decision and one explicit target

The next MVP unit is not a random citation occurrence and not an unbounded
treatment batch. It is one frozen pair:

```text
full citing decision + one explicitly identified target decision
```

The citing decision's complete text is always model context. The manifest must
name the target by stable citation keys and, when available, its A2AJ document
ID. Before any call, deterministic citation resolution must find and number
every explicit occurrence of that target in the citing decision. If the target
cannot be resolved or does not occur, the pair fails before inference. Random
selection may choose qualifying pairs, but the prompt never asks the model to
choose a citation or infer which cited case is the target.

One response dissects the citing decision into:

```text
opinions[]                    exact boundaries, authors, result positions
participants[]               authorship, full joins, partial joins, result only
case_issues[]                shared legal questions within this decision
opinion_issue_positions[]    each opinion's answer, basis, limits, and spans
partial_issue_joins[]        issue scope of any joins-in-part
target_mentions[]            target occurrences, voice, opinion, and issue links
target_treatments[]          treatment by opinion and issue, with exact evidence
target_direct_history[]      same-litigation appellate history only
```

`case_issues` supplies the common identity needed to compare majority,
concurrence, and dissent on the same question. Each
`opinion_issue_position` records that opinion's answer; it does not collapse
competing answers into one case-level holding. Judge-by-issue positions are
then derived from authorship and full joinders. A partial joinder is accepted
only when the response scopes it to issue IDs with evidence. Result-only
agreement adopts no reasoning. The controlling position on an issue is derived
from judge support for that position, so a case-level majority label cannot
silently create a majority rationale.

Every target-treatment event must link to a target mention, containing
opinion, and one or more citing-case issue IDs. It records the target
proposition only **as characterized by the citing opinion**. Attribution keeps
current-court speech distinct from counsel, quotation, reported decisions,
procedural recounting, and metadata. Treatment may differ by issue and by
opinion. The model sees the full citing decision and declares exact treatment
discussion spans; validation must not confine it to an arbitrary fixed-width
citation window.

The rich events are the audit record, not the inference-time payload. After
validation, deterministic code also emits a compact `flat_treatment` edge:

```text
controlling_labels[]         issue-majority-supported treatment labels
other_judicial_labels[]      non-controlling judicial treatment labels
attributed_labels[]          counsel, quotation, reported, or unclear speech
direct_history_labels[]      separate same-litigation history
issue_slices[]               those label buckets for each local case issue
flags                        controlling reliance/adversity/explanation,
                             non-controlling adversity, attributed adversity,
                             court-treatment, mention-only, direct-history
```

These are derived multi-label flags, never a model-supplied `is_good_law`
score. Every compact value remains traceable to the rich event, exact quote,
opinion position, and issue-support calculation. This is the small form used
for filtering, corpus analysis, and low-token inference-time authority hints.

### Authorized 15,000-call shared learning budget

The frozen discovery seed is `20260820`. Its manifest contains 5,000 distinct
citing decisions, one target per decision, across all 29 A2AJ datasets. It is
dataset-stratified for failure discovery rather than corpus-proportional:
3,935 targets resolve to an A2AJ decision and 1,065 are plausible external
neutral or reporter citations. Source decisions over 400,000 characters are
excluded. The target decision text remains absent in this arm.

The authorization now caps all extraction and grading models together at
15,000 attempted submissions. Failed transports count. A single append-only
ledger records a carry-forward of 97 earlier attempts, every new call before
launch, its terminal status and usage, and each run's budget check. The runner
refuses a planned batch whose logical calls plus the adapter's one permitted
retry per call could cross the cap. The first event from any retry is a separate
`model_call_retry_started` ledger entry; completed receipts also report the
retry count. Thus a reset stream consumes two submissions even though it yields
one logical case answer.

The immediate controlled cell is the 15 pairs frozen in
`case-target-prompt-cell-15.json`: the five directly human-annotated
development cases plus ten untouched holdouts from BCCA, BCSC, CHRT, CIRB,
CITT, CMAC, FCA, NSPC, OHSTC, and YKCA. Compare four Luna Max prompt forms on
the same pairs: the prior baseline, a verbose rules prompt, a concise
principles prompt, and the concise prompt with generic examples. Grade each
arm on the five human cases with Sol Max, then compare all four anonymized
candidates in one Sol Max call for each holdout. Candidate order and IDs are
blinded to prompt name. Sol Ultra was tried once and rejected by this direct
one-response transport; it is an orchestration preset, not the adjudicator for
this cell. Do not use the holdout to edit prompts and rerun this cell.

Select an arm by evidence in this order: human-gold semantic usability and
critical legal errors; blinded-holdout semantic usability, treatment and
authority scores, and preferred-candidate count; then fail-closed opinion and
target validity. Use latency and tokens to break a material quality tie. If
the verbose arm does not produce a clear semantic gain, prefer the shorter
arm. Deterministic salvage is reported separately and cannot convert a
semantically wrong record into a win.

Every extraction uses one isolated flat-subscription child, one case-target
pair, and at most ten workers. The grading tools use the same one-case-per-child
discipline. Before selecting cases or touching run outputs, the parent proves
`auth_mode=chatgpt`, an account-bound OAuth token, and the exact
`https://chatgpt.com/backend-api/codex` endpoint. Every child removes
`OPENAI_API_KEY`, `CODEX_API_KEY`, and `OPENAI_BASE_URL`; an API-key route is a
hard failure. Receipts bind the endpoint, auth mode, adapter/helper hashes, SDK
version, and response ID. UTF-8 prompt bytes cross the Node/Python boundary as
Base64 so nested JSON cannot reinterpret supplementary characters.
Raw event lines, raw final answers, source and prompt hashes, usage, elapsed
time, deterministic validation, grader output, and arm mappings are preserved
before aggregation. Extraction remains Luna Max for every case; stronger Sol
Max is an adjudicator, not another candidate extractor. Lower Luna effort is
tested only after a prompt is selected.

Provider events are written as they arrive. The parent computes a streaming
SHA-256 and retains only the small preflight/completion receipts in memory; it
does not duplicate or size-cap the event stream. A local transport check emits
more than 16 MiB (the retired buffer limit) and must complete with every event
observed before live cells are launched.

Report whole-record success only as the strictest gate. The main yield measures
are accepted/submitted opinion positions, partial joins, target mentions,
treatment events, and direct-history events. Break those measures down by
dataset, source length, resolved versus external target, occurrence count,
attribution, treatment label, and controlling versus non-controlling opinion.
Use disagreements and grounding failures to create review queues; do not turn
validator survival into semantic accuracy.

This replaces the sampled-two-citations semantic MVP and the ID-heavy v12
contract. The current v14 model schema is nested by issue, answer group, and
per-opinion position. The model supplies legal meaning and exact evidence; the
harness owns every internal ID, target occurrence, character offset, opinion
containment link, and flat treatment projection. The only identifier in model
output is an occurrence ID supplied in the input packet. The full citing
decision appears once. Deterministic preflight and structure dumps are not
model context.

The five-case v13 canary is frozen diagnostic evidence, not a v14 score. It
showed that Luna Max can recover multi-opinion issue positions and treatment,
but also exposed model-authored name mentions, optional-evidence cascades,
redundant partial joins, panel-roster authorship, and nearly exact boundary
quotes. V14 makes occurrence identity host-owned, validates optional basis
items locally, removes redundant partial joins, rejects panel rosters as
authors, and allows conservative auditable boundary recovery. Historical raw
answers are recompiled only against their original occurrence receipt; there
is no live compatibility branch.

The frozen five-case v14 extraction is complete. Three cases returned final
answers and two timed out after retaining their full provider streams. Offline
v15 recompilation accepts the YKCA and ONCA records, keeps the CIRB record
partial because one complete claimed basis lacks grounded evidence, and makes
zero model calls. Do not add cases until these three semantic records have
been compared with independently audited source annotations.

The old one-case app-server repair canary tested the retired ID-heavy v12
contract. Same-thread feedback fixed six of seven linked-record errors but used
47,971 input tokens, and a fresh full-context retry emitted malformed JSON.
V15 first removes those cross-link failures. Any new repair test must be a
single per-case continuation that changes only validator-named fields, retains
every attempt, and proves better whole-record validity at an acceptable token
cost; it is not permission for a shared hot session or automatic full-record
regeneration.

### Grounding contract audit

Beaver's production contract selects the smallest model-visible evidence block
before drafting a support unit, binds the unit to host-owned evidence handles,
checks exact quotations deterministically, and permits bounded same-session
repair. The case-target harness already follows most of that boundary: the full
closed record is visible once, occurrence identity is host-owned, semantic
objects carry exact source quotes, and the compiler resolves containment and
offsets without trusting the model.

Before changing the schema again, use the 15 development/audit cases to test
two remaining hypotheses while scoring only the final case graph:

1. reorder otherwise identical schema fields and instructions so Luna selects
   exact evidence before writing the answer, basis characterization, voice, or
   treatment label; and
2. require a short local attribution-cue quote for each target occurrence, or
   show that host context plus the existing occurrence offset performs just as
   well without the extra output.

Measure whole-record semantic correctness, grounding rejection, visible and
reasoning tokens, latency, and repair need. Do not promote an entailment model
or lexical-overlap score as truth: Beaver's own held-out work found cheap
framing detectors unsuitable as acceptance gates. Exact validation remains
deterministic; semantic verification remains gold/evaluation work.

### Planned context arms (do not run yet)

Hold the frozen case-target pairs, schema, model, effort, and output contract
constant while changing only the supplied context:

1. **Citing decision only:** full citing decision, target identity, and
   deterministic target-occurrence map.
2. **Citing + target decision:** add the complete resolved target decision.
   Preserve separate source hashes and delimiters. The response must keep
   `target_rule_from_target_text` distinct from
   `target_rule_as_characterized_by_citing_opinion`, so disagreement is data
   rather than silently reconciled by the model.
3. **Resolved authority packet:** only after arm 2 is understood, optionally
   add complete texts of other cited decisions that the model must use to
   explain the target's treatment. Do not dump every citation into context;
   resolve and freeze the packet first, record omissions, and enforce a common
   context budget across paired arms.
4. **External characterizations:** later judicial decisions, legal journals,
   or both, each in separate provenance-tagged blocks as already specified
   below.

Arm 2 is more than a retrieval convenience: it can correct a citing court's
shorthand, anchor the model to the target's actual language, or distract it
from the only question being measured--what the citing judges did with that
target. Evaluate it as a context intervention. Score the citing-case ontology
unchanged, then separately score characterization fidelity, treatment, tokens,
latency, omissions, and whether the added text causes source confusion. Arm 3
is deferred until arm 2 shows value because transitive authority packets can
expand rapidly and change which legal problem the model solves.

### Decision after the adversarial review

No public benchmark establishes the complete claim this project needs to make.
The project must separately test four claims:

1. the extractor accurately represents the issues a decision resolves;
2. the representation improves retrieval beyond ordinary compression;
3. opinion support and treatment data prevent authority-sensitive mistakes at
   inference time; and
4. extracted records remain stable and useful enough for corpus analysis.

[CanLegalRAGBench](https://arxiv.org/abs/2605.30497) is demoted to a secondary
Canadian QA and compression regression test. Its questions are generated from
seed cases, its relevant-document sets are incomplete, and it does not score
issue scope, opinion side, treatment, hierarchy, or law as of a date. An issue
card generated from its seed case may simply resemble the generated query.
That is not proof of authority-aware legal research.

Build the missing Canadian test as a small extension of the existing
`benchmarks/beaver_can` contract. Reuse its required issues, propositions,
authorities, acceptable pinpoints, conclusions, forbidden claims, source
packets, and law-as-of dates. Reuse the existing A2AJ and journal
`LegalSourceProvider`/`SourceDoc` paths, citation keys, opinion graph, receipts,
and runner. Do not create another benchmark schema, corpus store, runner, or
general legal ontology.

This is a gated experiment. A valid outcome is to keep only deterministic
opinion and citation metadata, extract issues lazily, or delete the semantic
issue layer.

### Records to test

#### Shared issue and opinion position

An issue is shared only within one citing decision. It is not a universal
doctrinal node. Each opinion then takes its own evidenced position on that
issue:

```text
case_issue
  local_id                 temporary ID within one response
  question                 normalized legal question
  parent_issue_id          nullable local decomposition only

opinion_issue_position
  local_id
  case_issue_id
  opinion_id
  answer                   this opinion's answer
  basis_and_limits[]       typed rule, application, qualification, exception,
                           or independent ground
  relation_to_disposition  dispositive | independent_alternative |
                           non_dispositive | unclear
  discussion_spans[]       exact complete discussion spans
  evidence[]               exact quotes, voice, and supported field
```

Every answer, basis, limit, and disposition judgment links to evidence.
Evidence voice is current court, party, quoted authority, reported decision,
procedural record, or unclear. At least one answer span is current-court speech.
Discussion spans may cross paragraphs and overlap other issues.

Use this granularity rule:

> Create one shared issue for each legal question on which at least one opinion
> takes a position. Keep an applied test together unless an opinion decides an
> element or independent ground separately. Put competing majority,
> concurrence, and dissent answers under the same issue ID. Do not convert a
> question merely recounted, argued, or expressly left undecided into the
> current opinion's resolved answer.

Do not build a cross-case proposition graph. A later reader retrieves a shared
issue, the relevant opinion positions, and their exact spans. The target-case
treatment link says which citing-case issue the target bears on; it does not
claim that the local issue ID is a universal identifier.

#### Target-case treatment

The manifest identifies exactly one target decision. Deterministic parsing
provides stable IDs for every explicit target citation occurrence. The model
may add exact short-form or name mentions, but must link them to that target and
the validator preserves them as model-resolved rather than deterministically
proven identity.

A treatment event links target mention IDs, containing opinion, citing-case
issue IDs, treatment label and scope, speaker/attribution, exact evidence, and
an optional proposition **as the citing opinion characterizes it**. Direct
appellate history between the citing and target decisions remains separate.
The history of the target with some third case is reported context, not direct
history for the source-target pair.

All explicit target occurrences must be accounted for, including occurrences
in counsel submissions, quotations, metadata, or procedural history that
produce no court treatment. Case-level indicators are derived from
issue-specific events and judge support; there is never a scalar `is_good_law`
field. The same target may be followed on one issue, distinguished on another,
and criticized only in dissent.

#### Judicial and scholarly characterizations

Use a small provenance-bearing assertion record for a source's characterization
of another decision:

```text
assertion_id              harness-assigned after validation
source_document_id        decision or journal article
source_actor_type         judicial_opinion | scholarly_author |
                          editorial_material | party
source_span               exact evidence and source hash
source_date               date at which the assertion was made
claim_type                issue_characterization | rule_characterization |
                          treatment_characterization | critique
claim_text                normalized assertion
target_decision_id        citation key allowed when A2AJ ID is unavailable
target_issue_id           nullable
target_treatment_event_id nullable
```

This is a provenance distinction, not a source-of-truth hierarchy. A later
court's text proves what that court said or did; it does not prove that the
court accurately characterized the earlier decision. A peer-reviewed journal
analysis may be the better account. Preserve court, journal, citator, editorial,
party, model, and reviewer assertions separately and make agreement and conflict
queryable. Do not merge a scholarly formulation into the source decision's own
issue card or force it onto an issue at the wrong level of abstraction.

The repository already has a local journal provider with full text, authors,
dates, licences, source hashes, stable page/section/footnote locators, and
exact-source lookup. Route journal work through that provider rather than
building a new article corpus.

### Deterministic and semantic boundaries

The model returns semantic judgments and verbatim anchors. The harness derives
or validates, where mechanically possible:

- persistent IDs, character offsets, paragraph intersections, and hashes;
- citation identities and citation-occurrence IDs;
- source type, document, court, jurisdiction, and date;
- opinion boundaries, authors, joiners, participants, and nonparticipants;
- judge/court service-registry matches;
- chronological eligibility for an as-of query; and
- judge-by-issue support from authorship, full joinders, and validated
  issue-scoped partial joinders.

The harness cannot validate entailment merely because a quote exists. It also
cannot infer universal issue-level support from a case-level result:

- a judge's presence on the panel or agreement with reasons does not prove
  authorship;
- a signature is authorship evidence only when its local form identifies the
  signed reasons as that judge's own;

- result-only agreement does not adopt another opinion's reasons;
- an unscoped `joins_in_part` does not support a particular issue;
- `lead` does not mean majority;
- a plurality or separate concurrence may support the result on another basis.

Derive each judge's issue position using the smallest supported rule: an author
adopts the positions in that opinion; a full join adopts them all; a validated
partial join adopts only its listed issue positions; result-only agreement
adopts none. Aggregate judge support independently for each competing answer.
Emit `majority_supported`, `unanimous`, `plurality_supported`, `minority_only`,
`no_majority_rationale`, or `authority_ambiguous` only after that issue-level
count. Missing or unscoped partial-join evidence stays ambiguous rather than
being filled from the case disposition.

### Combined versus staged extraction

Do not assume one or two stages is better. Compare frozen case-target pairs:

1. **Combined:** one call reads the full citing decision and returns structure,
   shared issues, opinion positions, partial issue joins, target mentions, and
   issue-linked treatment.
2. **Structure first:** call one returns opinions, participants, shared issues,
   opinion positions, and partial joins. Call two receives the full citing
   decision plus those resolved records and returns target mentions and the
   identical treatment contract.

Both modes receive the same full citing text, explicit target identity, and
deterministic target-occurrence map. The staged arm is not allowed to replace
the full decision with excerpts. Compare boundary/vote accuracy, issue recall
and split/merge behavior, judge-by-issue support, target identity, occurrence
coverage, issue-linked treatment, attribution, schema failures, tokens,
latency, and accepted yield. Only add a third semantic stage if this paired
test exposes a specific interference failure.

Large decisions are never silently truncated. Record an over-limit pair and,
only if needed, split on validated opinion boundaries while repeating the
target-occurrence map and maintaining one case-level reconciliation receipt.

Each case remains a distinct isolated Codex subscription process. All runs
after the stopped 4,950-case dispatch use exactly five workers, with one case
per worker per dispatch. Every provider
event and final response is appended before validation, and every run is
resumable. No hot multi-case model session is permitted.

### Luna effort and verifier experiments

Luna Max is the provisional extractor for every case-target MVP pair, but it is
not an oracle. Establish the Max contract and error profile first. Test lower
efforts only later against the same locked reviewed pairs, without showing one
effort's answer to another. Test medium only if low fails and high/max leave a
meaningful unresolved cost-quality question.

A lower effort earns a production role only if it:

- adds no severe error on the locked items;
- does not materially reduce issue or treatment coverage;
- saves at least 25% of end-to-end cost after retries and escalation; and
- has a routing rule that identifies its failures.

If more than roughly one third of lower-effort results escalate, use Max
directly. Because deterministic parsing already removes easy cases, Luna sees
the difficult tail; a cheap tier may have no useful production role.

Test any proposed Max verifier with known corruptions: swapped answers, removed
qualifications, dissent relabelled as majority, reversed treatment, counsel or
quoted evidence attributed to the court, and treatment attached to the wrong
citation. Use about 30 clean and 30 corrupted records. Delete the verifier if
it does not catch nearly all injected severe errors or adds little beyond the
deterministic checks. A verifier reading only selected evidence cannot measure
issues omitted from the full opinion.

### Verification status and human work

Do not use an ordinal truth ladder. Store independent receipt facts:

```text
anchors_valid
cross_pass_consistent
max_reconciled
external_assertions_present
human_claim_checked
human_full_opinion_checked
unresolved
```

Two Luna passes have correlated errors. Agreement measures reproducibility and
can route review; it does not establish correctness. A Max reconciliation after
seeing candidate answers remains a model-produced record and may be anchored by
them. Preserve all inputs and raw answers.

Use three samples and never pool their percentages:

1. a reproducible probability sample across A2AJ datasets, courts, dates,
   languages, lengths, and opinion structures;
2. a challenge sample enriched for multiple opinions, partial joins,
   alternative grounds, party argument, reported decisions, quotation, and
   procedural history; and
3. a treatment sample of unique citing/target pairs, reported by treatment and
   attribution class.

Retain selection probabilities for quota-sampled strata. Compute intervals by
decision or article, not by their correlated issue records or citation
sentences.

Human review has two different jobs:

- **Claim audit:** accept, edit, or reject a card/event against its exact spans.
- **Blind full-opinion inventory:** list resolved issues before seeing model
  output. This is the only direct check on issue omission and split/merge error.

Use sequential caps suited to one reviewer:

1. **Zero-call contract:** completed for a frozen 15-case challenge set. The
   three human-gold files cover five multi-opinion/partial-join cases, five
   attribution traps, and five controls; all source anchors validate locally.
2. **Max MVP:** rerun the same five-case canary under v14, then add the other ten
   only after inspecting every first-slate result. Keep one full citing
   decision and one target per isolated Luna Max call.
3. **Architecture ablation:** if the combined contract is viable, use at most
   eight locked pairs for combined versus structure-first treatment. The
   two-stage arm costs two calls per pair; do not enlarge it before inspecting
   all eight.
4. **Context ablation:** on the same small locked set, compare citing-only with
   citing-plus-target text. Add the broader authority packet or external
   characterization arms only if the target-text arm shows useful movement.
5. **Effort and locked pilot:** test lower Luna efforts and a larger probability
   sample only after the Max schema, architecture, and context are fixed.
6. Re-review three decisions and ten target-treatment claims later without the
   first labels visible to detect rubric drift.

Review in batches no larger than five full decisions. If more than two MVP
decisions require changing a field's meaning, revise the schema and freeze a
new batch rather than adding cases. Existing machine-grounded outputs can seed
review queues, but exact anchors and cross-pass agreement do not replace the
small blind issue inventory needed to measure omission.

Predeclare severe errors:

- assigning an opinion to the wrong author or converting unresolved authorship
  into a named writer;
- reversing or materially overstating the opinion's answer;
- omitting a qualification so the rule becomes materially broader;
- treating a party, quotation, reported decision, dissent, or plurality as
  controlling reasons;
- assigning treatment to the wrong decision, occurrence, or issue;
- missing negative treatment that changes the queried proposition's use;
- inventing a proposition not supported by the cited evidence; or
- giving majority support to a proposition without the necessary joinders.

Formatting failures, harmless wording differences, and slightly imperfect but
valid anchors are not severe.

### Silver construction

Deterministic validation proves offsets, identity, containment, ordering, and
some opinion relationships. It does not prove a semantic claim. Machine silver
may record `cross_pass_consistent` or `max_reconciled`; neither is a confidence
score.

The simplest production pipeline may be one Max extraction, deterministic
validation, and random quality-control reruns. Do not pay for two correlated
model calls per case unless the locked experiment shows that the second call
materially reduces human-observed errors.

Later judicial descriptions, scholarly analysis, citator classifications,
editorial summaries, and verbatim quotations are independent assertions and
valuable challenge/evaluation signals. No source class is presumed correct.
Conflicts are retained as first-class review cases.

Do not create the proposed 1,000-case semantic silver sample before the oracle
utility experiment shows that accurate records would be useful. Do not start a
whole-corpus issue build.

### Benchmark portfolio

#### Local scalable retrieval sets

Build two known-target query sets without inventing questions:

1. **Judicial contexts:** mask a resolved citation in an A2AJ citing passage and
   retrieve the cited earlier decision and, where a quote or pinpoint permits,
   its supporting passage.
2. **Journal contexts:** mask case names, neutral and reporter citations, short
   forms, footnote cross-references, and other target leakage from a substantive
   article passage, then retrieve the cited decision and relevant issue span.

Journal and judicial contexts are equal provenance-bearing observations. The
journal set is particularly valuable because a human scholar wrote the case
characterization independently of the issue extractor. Record venue, authors,
publication date, review provenance when known, source hash, and licence.

Use singleton citations with pinpoints as the clean passage-retrieval stratum.
Singleton citations without pinpoints support document retrieval. String
citations and composite propositions have incomplete positive sets and must be
scored separately. Pure citation lists, background references, party material,
and procedural history are separate strata, not silent positives or negatives.

Split by citing decision or article and target-case family. Candidate decisions
must predate the query source. Use the full eligible corpus when feasible, or a
documented first-stage pool with hard negatives matched by court, date, and
topic. Do not use only 999 random negatives. The observed citation is a known
positive, not the only legally acceptable answer; report MRR and known-target
recall rather than misleading precision.

Audit 50-100 short journal contexts across singleton-pinpoint,
singleton-no-pinpoint, string-citation, and express-treatment strata before
using them as a benchmark. At roughly three to five minutes per context, this
is a separate four-to-eight-hour human gate. Keep hashes, offsets, and only
authorized excerpts; do not commit a downloaded article corpus.

#### Authority-sensitive Beaver-CAN slice

Add two reviewed tasks for each of six failure patterns to the existing
Beaver-CAN framework:

1. the tempting proposition appears in a dissent, not the majority;
2. an older case receives negative treatment on the queried issue;
3. negative treatment concerns a different issue and the case remains useful;
4. counsel or a reported decision characterizes authority without adoption;
5. separate concurrences agree in result but no rationale has majority support;
6. a later case narrows one ground while leaving another intact.

Twelve carefully reviewed tasks are the initial acceptance set. Models may
propose task candidates and source packets, but extracted cards may not define
their gold. Existing Beaver-CAN propositions, acceptable authorities and
pinpoints, forbidden claims, and law-as-of dates provide the durable contract.

#### External component checks

Use each external benchmark only for the claim it can support:

- [COLIEE Task 1](https://coliee.org/COLIEE2025/corpus/task1) tests Canadian
  cited-case retrieval; [Task 2](https://coliee.org/COLIEE2025/corpus/task2)
  tests cross-case paragraph entailment when the target decision is known.
- [SG-LegalCite](https://arxiv.org/abs/2605.21057) is the closest published
  principle-augmentation design. Its main result uses an LLM principle
  extracted from the citation-bearing context, a 1,000-way sampled pool, and
  partially validated silver. Its cold-start test contains only 50 cases.
- [AusLaw Citation](https://doi.org/10.1007/s10506-026-09506-9) supports
  comparing full text, editorial catchwords, and aggregated reasons for
  citation. It does not supply Canadian opinion-side or treatment labels.
- [Validate Your Authority](https://aclanthology.org/2025.nllp-1.13/) and the
  [236-pair overruling benchmark](https://arxiv.org/abs/2510.20941) are
  out-of-jurisdiction treatment and long-context checks.
- [CLERC](https://aclanthology.org/2025.findings-naacl.441/) and LePaRD are
  external citation- and passage-retrieval stress tests, not Canadian
  acceptance gates.
- CanLegalRAGBench remains an ordinary Canadian RAG regression and
  compression check only.

The literature supports the experiment, not its conclusion. SG-LegalCite
reports large gains from explicit principles, while its own worked example
extracts a principle from a passage recounting stakeholder submissions--an
example of the attribution error Beaver must avoid. Scholarly legal citation
recommendation has also been evaluated directly over article text
([Arslan et al.](https://arxiv.org/abs/2311.05902)). Multiple-model agreement
must be treated cautiously because LLM evaluator errors are strongly correlated
([Kohli et al.](https://machinelearning.apple.com/research/correlated-llm-evaluation-panels)).

### Proving downstream value

Test the oracle upper bound before building large silver. If human-accepted
issue/treatment records do not help, model extraction cannot rescue the idea.

First hold retrieved source packets fixed and compare, at the same input-token
budget and with the same reader/output contract:

1. raw passages;
2. raw passages plus deterministic opinion, vote, date, court, and citation
   metadata;
3. equal-token generic summaries with exact evidence;
4. human-accepted issue cards with exact evidence but no authority/treatment;
5. the same issue cards plus opinion support and treatment.

The generic-summary control separates issue structure from ordinary
compression. The deterministic condition asks whether cheap metadata captures
the value. Run a small intentionally corrupted-card condition to measure
whether confident structure makes the reader credulous.

Only after the oracle layer helps, add Luna silver as a sixth condition. Then
run retrieval separately on the masked judicial and journal contexts, comparing
raw-text, generic-summary, and issue-card indexes. Do not change retrieval and
reader packets in the same initial experiment.

Score:

- required proposition and conclusion accuracy;
- forbidden-claim and severe-error rates;
- authority, opinion-side, treatment, and law-as-of correctness;
- supporting-span, quotation, and pinpoint correctness;
- qualification retention and omitted contrary authority;
- document and passage MRR/Recall@k;
- input/output tokens, model calls, paired wall time, and retry rate; and
- offline extraction and validation cost.

Randomize and interleave paired conditions. Inspect changed answers blind to
condition. A small pilot is a kill test for a large effect, not evidence of a
two-point non-inferiority margin.

Advance from oracle to silver only if the oracle layer causes no new severe
authority error and achieves at least one large practical effect:

- at least 10 absolute points more known-target Recall@10 or supported-answer
  accuracy at comparable cost;
- at least 30% fewer inference input tokens with no worse reviewed answers; or
- at least a two-to-one win among materially different paired answers.

Stop semantic extraction if deterministic metadata comes within roughly two
points of oracle retrieval or within 10% of its token savings. Silver advances
only if it retains at least 75% of the oracle improvement and introduces no new
severe error in reviewed changed answers.

Report quality-cost frontiers and:

    break_even_queries = offline_extraction_and_validation_cost /
                         per_query_cost_saving

There is no break-even when per-query saving is zero or negative. Beaver has no
observed query-frequency distribution, so show sensitivity at 1, 5, 10, 50,
and 100 uses per enriched decision rather than inventing a workload.

### Corpus-analysis value

Answer-generation success does not prove analytical validity. Only after the
oracle and silver utility gates pass, extract a reproducible 1,000-decision
sample with broad A2AJ coverage and known selection probabilities.

Predeclare a small set of doctrinal discovery questions and compare raw text,
deterministic metadata, equal-token generic summaries, and issue cards. Measure
known-target recall from masked judicial and scholarly contexts, precision in
human-reviewed top results, cross-run stability, review time, and coverage by
dataset, court, period, language, length, and opinion complexity. Report
stratum-specific error. Natural-language cards may support search and
clustering; prevalence estimates remain exploratory until the relevant strata
are audited.

### Gated execution order

1. **Zero-call case-target contract:** define the manifest, strict schema,
   deterministic occurrence map, exact-anchor validator, issue-level vote
   derivation, and four local fixtures. Confirm licences and temporal fences
   for the later target-text and external-characterization arms.
2. **Max MVP:** after separate authorization, run 15 frozen diverse pairs, one
   full citing decision and one explicit target per call. Audit five complete
   decisions and a randomized spread of the remaining claims.
3. **Schema decision:** keep, simplify, or reject the ontology before any more
   inference. Do not tune fields against a growing succession of cases.
4. **Architecture and context ablations:** run the capped combined/staged and
   citing-only/target-text comparisons on a small locked subset. Do not run the
   all-authority packet yet.
5. **Oracle utility:** add the authority-sensitive Beaver-CAN tasks and a small
   masked-context set; compare fixed reader packets before producing large
   semantic silver.
6. **Locked extraction and silver utility:** only if the oracle records help,
   test lower effort tiers, verifier mutations, and how much extraction noise
   destroys the oracle gain.
7. **First scale-out and external confirmation:** only after silver passes,
   extract at most 1,000 broadly sampled pairs, then run the relevant external
   component checks. CanLegalRAGBench remains a regression suite.

Defer a global issue taxonomy, a cross-case issue tree, a formal argument graph,
universal ratio/obiter labels, forced cross-case proposition identity, a scalar
good-law score, and whole-corpus extraction. The MVP does require local shared
issues, opinion-specific positions, issue-scoped partial joins, derived
judge-by-issue support, and target-treatment links; those are not optional
future ontology work.

### If issue alignment is too unreliable

The issue-linked representation is an empirical hypothesis, not a permanent
requirement. If the benchmark shows that models can accurately describe a
cited authority's treatment but cannot reliably normalize that treatment into
shared issues, the next arm will ask for a simpler account of what each
judicial opinion says or does with each cited authority. It will preserve the
opinion number, operation, attributed proposition, and exact evidence,
but omit cross-opinion issue grouping. This is a separate benchmark arm, not a
second representation added to the current output.

Both arms must distinguish the deciding court's own reasoning from quotations,
counsel's submissions, a lower decision under review, procedural narration,
and editorial metadata. Reproducing another speaker's words is not itself a
treatment by the current judicial opinion; its treatment requires evidence
that the opinion adopted or performed the stated legal operation.

The current schema also asks the model to classify each citation occurrence's
text source and whose proposition it reports. Keep those fields for the next
small comparison because making the distinction explicit may improve treatment
accuracy, but test them as removable scaffolding. Compare the same locked cases
with and without those occurrence classifications. Remove them if they do not
materially reduce false attribution or if they make the treatment output worse;
do not preserve redundant fields merely because they are already in Gold.

No metered run begins without separate explicit authorization. Durable positive
and negative findings go in RESULTS.md; raw responses and partial results remain
in ignored resumable receipts.

## Controlled paired run

Use one reproducible seed and one random case for the first smoke cell.

```text
same seed and same case
├── Luna-low run first
│   └── independent roster prediction
├── Qwen 9B / none / 32k run second
│   └── independent roster prediction; Luna output is not shown
└── comparison
    ├── judge identity and role agreement
    ├── opinion-span agreement
    ├── paragraph-role agreement
    └── runtime and turn count
```

Luna is a comparator/teacher candidate, not a hidden source of Qwen guidance. Its answer must be persisted separately and compared only after Qwen finishes.

## Source and structure truth

1. Read the local A2AJ corpus through the existing read-only provider path.
2. Compile paragraphs through the existing A2AJ `SourceDoc` compiler.
3. Before treating any roster as valid, audit the selected decision read-only at three levels:
   - raw stored A2AJ text;
   - the existing A2AJ structure summary;
   - emitted `SourceDoc` paragraph labels and ranges.
4. Audit the actual emitted paragraph set and reported missing labels. A gap is not itself a regression: the current compiler deliberately suppresses competing quoted-number ladders. Treat a gap as a structure regression only when raw evidence shows a decision paragraph was lost (for example, a heading joined to its own paragraph marker), and fail the experiment closed rather than teaching the model a false index.
5. Do not repair paragraph boundaries inside this experiment. Fix or test the shared structure machinery in its own lane.

## Read-only structure audit (2026-08-02)

- Full current-corpus sweep: 225,017 cases; 202,536 emitted a paragraph spine; zero compiler errors, duplicate labels, or non-monotone labels.
- 47,871 emitted spines (23.64%) have internal gaps. Most cannot be called defective without context because `monotoneScopes(maxGap=8)` intentionally excludes quoted/embedded number ladders.
- There are nevertheless 5,011 high-confidence heading-joined omissions. CITT is decisive: 4,647 omitted labels have a formal heading immediately followed by a dot-numbered paragraph, while recovery only runs for bracket numbering.
- `CITT PR-2023-044` (`Baja Construction Canada Inc.`) emits `par1` through `par15`, then `par17`, `par18`, `par20` through `par25`, then `par27` through `par32`; raw text contains the lost `[16]`, `[19]`, and `[26]` after sentence-style headings.
- `SourceDoc` computes `ranges.paragraph.missing`, but `summarizeA2AJSourceDoc` exposes only counts; no runtime caller consumes the missing-label signal.
- Initial Mike history finding: this is not a recent SourceDoc refactor regression. `c1142333` introduced missing-range computation; `d18580f1` introduced gap-tolerant monotone selection and hid ranges from the A2AJ summary; `622b01ae` added only title-case/bracket heading recovery.
- Independent ALR Quote Verifier lineage is now closed, read-only. Its nested repository is a separate Git root. Its first A2AJ structure commit, `882ce0a` (2026-07-12), introduced both the line-start marker rule and `monotone_scopes(max_gap=8)`; the accompanying test explicitly accepts the emitted sequence `[1, 2, 4, 6, 7, 8]`. Numeric contiguity was therefore never the shipped contract.
- `7e3764f` (2026-07-31) added a narrow improvement: recovery of title-case, bracketed heading-joined paragraphs. It did not change the line-start rule or gap-tolerant spine. It only invokes recovery for bracket style, so CITT's dot-numbered and sentence-style heading forms remain outside the reference implementation. This is a long-standing inherited coverage limitation, not a later Mike-only regression.
- The independent repository's full reachable history contains only those five structure-module commits; `7e3764f` is tagged `v1.02`. The parent of `882ce0a` contains no A2AJ paragraph-parser symbol, so no earlier committed contiguous-label implementation exists to have regressed.

## Deterministic preflight

Run the v5 deterministic pass before the model sees the case. It may complete a
case only from explicit document grammar or a mechanically compelled
single-opinion result. Report:

- judge/header candidates found by the existing lightweight header pass;
- exact opinion offsets, boundary quotes, writer, joiners, panel, and
  nonparticipants when the source states them;
- registry-backed identity matches separately from the raw displayed names;
- contradictions such as author absent from a nonempty panel, duplicate
  surnames, OCR disagreement, short bodies, and unresolved votes; and
- zero-hit results and routing reasons explicitly.

The pass may call a sole unopposed opinion majority and may translate explicit
reason ranges and joinders. It must route implicit authorship, damaged or
incomplete rosters, unmarked reported voices, and non-explicit multi-opinion
alignment to Luna. Add a new deterministic rule only for a recurring
cross-dataset grammar or validation invariant with a fixture; do not grow a
case-specific reporting-verb list. The 662-case anomaly challenge set is a
regression corpus, not a tuning target or accuracy benchmark.

## Qwen turn protocol

For every model turn, preserve a bounded audit in the existing progress stream:

- round and elapsed wall time;
- assistant text and thinking, when the provider exposes them;
- exact tool name and arguments;
- requested paragraph/range;
- lookup status, returned labels, and evidence ID;
- validation error and repair instruction.

Guide Qwen to use contiguous exact-range lookups, up to the existing per-call limit, instead of reading one paragraph at a time when a range is appropriate. Invalid locators must receive the valid canonical index and a precise next action.

The model must submit a complete partition of the actual SourceDoc paragraph set. It must not be rewarded for covering a merely numeric interval that contains nonexistent labels.

## Validation and evidence

Keep validation deterministic:

- opinion authors and judge names must occur in the source;
- every discovered panel member must appear in the vote graph;
- a sole substantive opinion must be the lead opinion;
- boundary quotes must be verbatim, unique, ordered, and long enough to anchor safely;
- exact source ranges may not overlap and must clear the substantive-word floor;
- result sides and relationships must agree with referenced opinion alignment;
- paragraph intersections are derived from exact offsets when a spine exists.

Use mechanical references only when explicit source boundaries cover the complete verified paragraph spine. Otherwise mark the reference unresolved. Human references remain a separate annotation path.

## Sidecar and comparison output

Store only derived metadata in the existing ignored sidecar SQLite:

- run configuration and seed;
- decision metadata and source hash;
- model predictions;
- judge-vote rows and exact opinion-text rows;
- evidence IDs;
- reference and metrics JSON.

Do not copy corpus text into the sidecar. Use the existing receipt/progress files under the already ignored `runs/` directory. The comparison command should print its result and write a file only when explicitly requested.

## Luna-high Codex exec screen

The lightweight Codex arm is a first-class command on the existing harness. It
runs each routed case independently through `gpt-5.6-luna` at high effort,
with an ephemeral, read-only, user-config-free Codex session and a strict JSON
output schema. The prompt contains the complete source text, optional paragraph
index, and term-search preflight. It does not contain the deterministic result.

Select explicit A2AJ document IDs on the command line:

```powershell
node experiments/a2aj_decision_roster_qwen/harness.mjs codex `
  --document-ids 123,456,789
```

For a longer arbitrary set, pass a UTF-8 file containing comma/newline-delimited
IDs or a JSON array of IDs:

```powershell
node experiments/a2aj_decision_roster_qwen/harness.mjs codex `
  --case-file experiments/a2aj_decision_roster_qwen/my-case-ids.txt `
  --out experiments/a2aj_decision_roster_qwen/runs/luna-high-check.json
```

Optional controls are `--model`, `--effort`, `--workers`, `--timeout-seconds`,
`--run-id`, and `--sidecar-db`. Defaults are `gpt-5.6-luna`, `high`, eight
workers, and 900 seconds per case. Omitting both explicit selectors retains the seeded `--seed`,
`--sample-size`, and `--scope` path.

The ignored run receipt records selection order, route, subscription transport identity,
model and effort, source/prompt/output hashes, elapsed time, token usage,
normalized prediction, exact source offsets and text hashes, derived paragraph
intersections, deterministic/mechanical comparison, and evidence IDs. The
progress JSONL and sidecar preserve per-case partial results.
The complete source and prompt body are not persisted; existing bounded header
and preflight snippets remain in the receipt for audit.

Each Luna case is a separate ChatGPT-subscription child process. The runner uses
an asynchronous worker pool with a default of eight and hard maximum of ten workers;
one case is submitted to a worker at a time, and receipts are restored to the
input order after the dispatch completes. `--workers N` may lower concurrency
for a local smoke test but cannot raise it above ten. The `submit_roster`
payload is also the strict `json_schema` object used by GPT Responses-style
structured output (`name: a2aj_opinion_votes`); the same schema is sent as the
subscription Responses `text.format` contract and embedded in the run receipt.

For corpus-scale screens, first create a reproducible manifest:

```powershell
node experiments/a2aj_decision_roster_qwen/harness.mjs manifest `
  --seed 123 --sample-size 30000 --scope ALL `
  --out experiments/a2aj_decision_roster_qwen/runs/luna-low-30k-manifest.json
```

Run that manifest with `--receipt-mode compact`. Completed cases are appended
to the adjacent `.receipts.jsonl` stream immediately after their sidecar row is
saved. If a long run is interrupted, repeat the same command with `--resume`;
the runner skips document IDs already present in that stream. The final JSON
receipt points to the stream rather than duplicating tens of thousands of
large per-case objects.

## Read-only run dashboard

The same append-only streams can be inspected with a small local dashboard;
it does not import the frontend build or modify the runner:

```powershell
node experiments/a2aj_decision_roster_qwen/harness.mjs dashboard `
  --port 8796 --frontend-url http://127.0.0.1:3000
```

Open `http://127.0.0.1:8796/`. The dashboard refreshes only on user request, shows a
progress bar and receipt counts, groups the run library by finished versus
failed/incomplete execution, and sorts finished runs by accepted outcome rate.
The default case scope is `All seeds / runs`; individual current and historical
runs are available from a compact selector in the detail header. Selecting a
run exposes paged, searchable cases sorted accepted → rejected →
structure unavailable → case failure. The case controls can filter to only
decisions with a concurring/dissenting (minority) opinion or sort those cases
first. Each case links to the local legal source viewer and displays the exact
character range, linking to its first derived paragraph when available.
`Receipts` downloads the raw JSONL stream for
later double-checking. Set
`--frontend-url` (or `BEAVER_FRONTEND_URL`) to the address where the Beaver
frontend is running so those source links open in the right app.

## Acceptance gates

- Typecheck and the runner self-test pass.
- Luna and Qwen select the same seeded case.
- Qwen’s prompt contains no Luna result.
- Raw-source and canonical-label audit reports no unexplained paragraph loss; otherwise the run is a structure regression finding, not a model score.
- Turn logs make it possible to tell whether Qwen understood the task, searched sensibly, used invalid locators, or stopped early.
- Paired comparison reports model agreement without pooling Luna and Qwen as one controlled model cell.

## Paragraph spine via competing +1 monotonic sequences

### Problem

`paragraphBlocks` (backend/src/lib/sourceDocA2AJ.ts:1063) scopes candidate
markers with `monotoneScopes(maxGap)` — a gap-tolerance bandaid:

- `maxGap=1` (a2aj mode) rejects real spines whose markers are heading-joined.
  2011 SCC 38 is a clean counterexample: `[1]`..`[111]` all exist, but 11 of
  them sit mid-line behind headings ("II. Facts, Proceedings and Issue
  1. Facts [3]", "III. Analysis [11]", "IV. Disposition [65]"), so the strict
  +1 scope fractures and the compiler emits 0 paragraphs. The reference
  implementation returns 107 (it bridges the residual holes with `maxGap=8`).
- `maxGap=8` (legacy/reference) admits end-of-doc citation lists as
  paragraphs: 1936 SCR 4's trailing `[1]`..`[20]` citation entries and 1936
  SCR 281's `[1]`..`[11]` reference list become a fake "spine" that the
  opinion/partition layer then trusts.

Digital A2AJ text has no missing glyphs: every `[N]` that "should" exist is
present. A marker is either (a) heading-joined (mid-line, recoverable), or
(b) part of a *competing* +1 sequence — an endnote/citation list or a quoted
provision of another case/statute. The mature reference (TFP
`sequence_page_map_detector.py`, PDF engine `footnote_pairing.py`
`select_label_backbone`) scores every candidate label site and selects the
strongest +1 monotonic chain, separating competing chains by scope.

### Plan (all inside sourceDocA2AJ.ts; no invocation from the worker/harness)

1. **Broaden heading-join recovery.** The current `looksLikeJoinedHeading`
   (sourceDocA2AJ.ts:836) rejects roman-numeral headings ("III.", "IV." —
   `^\p{Lu}\.$/` is single-letter-only) and trailing punctuation ("Facts,"
   in "II. Facts, Proceedings and Issue 1. Facts"). Adopt the reference's
   more permissive word grammar while keeping the uniqueness discipline (one
   exactly-matching candidate per missing label, bracketed by line-start
   neighbours). This alone recovers [3], [7], [10], [11], [16], [31], [35],
   [38], [43], [64], [65] in 2011 SCC 38.
2. **Competing-sequence scoring.** Port the reference scored DP
   (footnote_pairing.py `select_label_backbone`): each marker candidate earns
   a zone/substance score; adjacent +1 links earn a bonus; gaps are penalized
   (bounded); the global best increasing chain is the paragraph spine.
   Replaces the `monotoneScopes(maxGap)` split.
3. **Spine vs endnote disambiguation.** A second +1 chain in the tail whose
   blocks are citation-shaped (short bodies, reporter/case shape) is emitted
   as `footnote`-kind blocks (block model already has the kind), not
   paragraphs — recovering both structures instead of choosing one.
4. **Quoted provisions compete in the same scoring.** Keep
   `quotedDotProvisionStarts` as an explicit negative score rather than a
   hard fence, so a statute quote that also forms a +1 chain is excluded from
   the decision spine by score, and inline case pinpoints stay out.
5. **Tests.** Extend `__tests__/sourceDocA2AJ.test.ts`:
   - 2011 SCC 38 fixture -> `par1`..`par111` contiguous, `missing: []`
   - 1936 SCR 4 / SCR 281 fixture -> citation list emitted as footnote blocks,
     not paragraphs
   - quoted-provision + inline-pinpoint fixtures keep their refusal.

### Measurement gates

- SCC spine coverage on the 9000-row seeds: 1903/9000 today -> most of the
  209 modern marker rows (20 genuine failures like 2011 SCC 38) and the
  pre-2000 rows with real decision markers recover a spine.
- End-of-doc citation lists (1936 SCR 4, 281) must NOT become paragraphs;
  they become footnote blocks.
- 2011 SCC 38: `par1`..`par111` contiguous, `ranges.paragraph.missing = []`.
- All 50 sourceDocA2AJ tests + legalOpinionBoundaries tests keep passing;
  no regression on BCSC/FC/ONCA (95-100% spine coverage today).
- Re-capture seeds, `node harness.mjs verify --scope SCC` -> changed=0/9000.

## Verbatim user prompts for this revision

> ok, well we need luna to do its own run, then do the qwen run, then compare the two, yes. And I want you to inspect what qwen is doing within each turn to see if it understand the task and/or if there is some better way to guide it to hunt for majority/minority decisions. having it read whole paragraphs is probably not the fastest way to the solution, and having a deterministic layer either do some of the work, or report in the first model turn what was already tried and failed (e.g. we grepped for majority, minoirty etc and found 0 results), then we can probably make this faster.

> the fact that (1) it wrote the spans as several instead of just one and (2) the spans excluded certain paragraphs means that luna is not being instructred well here.

> a2aj paragraph labels are not non-contiguous. ever. if the structure layer is reporting that, read-only determine how severe taht issue is, because that would be a regression.

> check its work.

> write down ur plan (plus revisions I just asked for) into an .md

> write down my prompts to you verbatim

> plan + prompts

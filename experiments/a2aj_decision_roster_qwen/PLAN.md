# A2AJ decision-roster experiment

## Goal

Derive auditable substantive opinion bodies and judge voting relationships for A2AJ decisions. Use a high-precision deterministic extractor when the source makes the answer explicit, and route only unresolved cases to the richer Luna extractor. Opinion boundaries are exact source-text offsets with verbatim anchors; paragraph ranges are derived metadata, not the extraction contract.

The experiment must remain siloed from the inflight compaction/tool-structure work. It must reuse the existing A2AJ, `SourceDoc`, lookup, locator, evidence, and SQLite machinery. It must not grow a second family of runners, watchers, caches, bridges, or generated artifacts.

## Current architecture

1. The deterministic extractor recognizes explicit opinion ranges, author-bearing reasons headings, paragraph-start authors, BCCA joinders/signatures, and terminal disposition lines. It emits exact `[start, end)` offsets, boundary anchors, opinion alignment, and per-judge vote relationships.
2. A result is `ready` only when every substantive opinion has an author and alignment and every discovered judge has a result side. A sole unopposed opinion is `lead`; all judges who author or join it are majority, even when the source never uses that word.
3. `codex` normally accepts deterministic-ready cases locally and sends only `unresolved` or `unavailable` cases to Luna. `--force` is reserved for controlled cells whose input manifest was already prequalified for Luna.
4. Luna returns strict schema `a2aj_opinion_votes`: exact disposition and boundary quotes, named or collective authors, participants and nonparticipants, result positions, and evidenced author/joinder links. Validation resolves exact offsets, enforces a substantive-length floor and non-overlap, and verifies name, vote, and opinion-link evidence.
5. Each Luna case gets a distinct ephemeral `codex exec`. Runs use a bounded worker pool and persist the exact untruncated response before validation. Raw answers live once in an append-only `.outputs.jsonl` ledger; progress and receipts retain their hashes. Runs can resume without repeating completed document IDs.
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
cases and deterministic citation candidates:

1. **Combined:** one Luna call returns the opinion/vote extraction and the
   treatment events together.
2. **Staged:** the first call returns opinions/votes; the second receives those
   resolved opinion records and returns the same treatment-event contract.

Both modes use the same model, reasoning effort, source, citation edges, and
selection order. Compare opinion-boundary and vote accuracy, treatment label
and evidence accuracy, cross-record coherence, schema/validation failures,
latency, and tokens. Preserve raw output from every call. Do not select the
production mode until the paired results exist.

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

#### Issue card

An issue card belongs to one resolved opinion. It is a retrieval and reading
unit, not a universal doctrinal node:

```text
local_id                 temporary ID used within one model response
opinion_id               existing resolved opinion
question                 normalized separately answered legal question
answer                   the opinion's answer
basis_and_limits[]       concise reasons and qualifications, each typed
relation_to_disposition  dispositive | independent_alternative |
                         non_dispositive | unclear
discussion_spans[]       exact start/end anchors for the complete discussion
evidence[]               exact quotes, voice, and the field/claim supported
```

Every generated answer, basis, limit, and disposition-relation judgment must
link to one or more evidence records. Evidence voice is one of current court,
party, quoted authority, reported decision, procedural record, or unclear.
At least one answer or basis span must be current-court speech. Exact
discussion spans are the context returned to a later reader; they may overlap
across issues and need not follow paragraph boundaries.

Use this granularity rule:

> Emit one card for each separately answered legal question. Keep the elements
> of one applied test together unless the opinion gives them distinct answers
> or independent grounds that could later be accepted, rejected, or treated
> separately. If two independent grounds answer the same question, emit two
> cards with the same question and different bases. Do not turn a question the
> court expressly declines to decide into a resolved issue.

Do not precompute a proposition graph. When an inference model needs a precise
proposition, retrieve the issue card and its exact discussion span and let the
reader formulate the proposition for the current task. This tests the intended
use directly: for example, retrieve only issue discussions supported by the
majority. A treatment event may link to an issue when the match is clear, but
the link is nullable and never required to accept the treatment event.

#### Citation treatment

Treatment remains an occurrence-level event in the citing source and its
containing opinion. It records the target citation, treatment label and scope,
speaker/attribution, and exact evidence. Direct appellate history remains a
separate event family. The attribution vocabulary must cover current court,
party, quoted source, and reported lower-court or tribunal reasoning.

An optional proposition quote is accepted only when the citing source states
one explicitly. Treatment extraction does not hunt for a complete proposition
scope and does not create an issue record. Case-level indicators are derived
views over time-indexed events, never a scalar `is_good_law` fact. A case can be
distinguished on one issue and remain useful on another.

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
- opinion support from explicit whole-opinion authorship and joinders.

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

Initially derive `majority_supported`, `minority_only`, `plurality_supported`,
or `authority_ambiguous` only for the safe subset: sole unopposed reasons and
explicit full-opinion authors/joins. Partial joins remain ambiguous until an
observed coverage failure justifies issue-scoped join extraction.

### Combined versus staged extraction

Do not assume that opinion, issue, and treatment extraction must be one stage
or multiple stages. Compare two frozen modes on the same sources, citation
edges, model, effort, and selection order:

1. **Combined:** one call returns opinions/votes, issue cards, and treatments.
2. **Structure first:** the first call returns opinions/votes; one semantic
   call over the resolved opinion text returns issue cards and treatments.

Only split issues and treatment into separate semantic calls if these two modes
expose a specific interference failure. Compare boundary/vote accuracy, issue
recall and split/merge behavior, treatment accuracy, cross-record coherence,
schema failures, severe errors, tokens, latency, and accepted-record yield.
Both modes receive the same deterministically resolved, bounded citation-edge
batch. Never truncate a large case silently; record that it exceeded the
single-call cell and split only at an opinion or citation-edge boundary shared
by both modes.

Each case remains a distinct ephemeral `codex exec`, with up to ten cases in
parallel and one case per worker per dispatch. Every raw response is appended
before validation, and every run is resumable. No hot multi-case model session
is permitted.

### Luna effort and verifier experiments

Luna Max is the provisional quality-first extractor for issue and treatment
work, but it is not an oracle. Test low, high, and max independently against
the same locked human-reviewed items. Do not show one effort's answer to
another during scoring. Test medium only if low fails and high/max leave a
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

Use sequential caps, not one large commitment:

1. **Schema development:** 12 full decisions (six ordinary, six challenge) and
   30 treatment contexts. Run low, high, and max independently: 126 calls.
2. **Locked extraction pilot:** 20 probability-sampled decisions, 10 challenge
   decisions, and 60 treatment relationships, again at the three efforts: 270
   calls. Blindly inventory at least ten probability decisions and claim-audit
   a broad random sample of accepted and rejected records.
3. Re-review three decisions and ten treatment contexts later without the first
   labels visible to detect rubric drift.

These are model-call and human-work ceilings for separate gated phases. Review
in batches of ten. Budget roughly 6-10 human hours for schema development and
10-18 additional hours for the locked pilot; stop and reassess if the compact
receipts do not make those ranges realistic. If more than two development
decisions require changing the meaning of a field, revise the schema and freeze
a new batch rather than enlarging the sample. Even zero severe errors in 30
independent decisions leaves an approximate 95% upper bound near 10%; do not
claim a tiny corpus error rate.

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

1. **Zero-call feasibility:** confirm benchmark/data access, licences, citation
   mappings, journal footnote scope, temporal fences, and leakage controls.
2. **Schema development:** run the capped 126-call cell and revise until one
   reviewer can apply the issue/treatment rubric consistently.
3. **Oracle utility:** add the twelve authority-sensitive Beaver-CAN tasks and
   a small masked-context set; run the fixed-packet representation comparison.
4. **Locked extraction:** only if oracle records help, run the capped 270-call
   low/high/max comparison and verifier mutation test.
5. **Silver utility:** compare accepted Luna records with the oracle condition
   and measure how much value extraction noise destroys.
6. **First scale-out:** only after silver passes, extract at most 1,000 random,
   broadly covered A2AJ decisions with random quality-control review.
7. **External confirmation:** run the relevant COLIEE/component checks and use
   CanLegalRAGBench only as a regression suite before making broader claims.

Defer a global issue taxonomy, issue trees, formal argument graphs, universal
ratio/obiter labels, per-judge issue stances, forced cross-case proposition
alignment, a scalar good-law score, forced issue links, and whole-corpus
extraction. Add one only when a measured failure requires it.

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

The ignored run receipt records selection order, route, Codex CLI version,
model and effort, source/prompt/output hashes, elapsed time, token usage,
normalized prediction, exact source offsets and text hashes, derived paragraph
intersections, deterministic/mechanical comparison, and evidence IDs. The
progress JSONL and sidecar preserve per-case partial results.
The complete source and prompt body are not persisted; existing bounded header
and preflight snippets remain in the receipt for audit.

Each Luna case is a separate `codex exec --ephemeral` process. The runner uses
an asynchronous worker pool with a default of eight and hard maximum of ten workers;
one case is submitted to a worker at a time, and receipts are restored to the
input order after the dispatch completes. `--workers N` may lower concurrency
for a local smoke test but cannot raise it above ten. The `submit_roster`
payload is also the strict `json_schema` object used by GPT Responses-style
structured output (`name: a2aj_opinion_votes`); the same schema is written to
the Codex `--output-schema` file and embedded in the run receipt.

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

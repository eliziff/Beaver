# Legal grounding experiment log — 2026-07-30

Status: **completed benchmark experiment; not production-validated**. The
experiment is off by default. This log owns the hypotheses, fixed comparisons,
failure evidence, and promotion decision for this four-stage run. It does not
convert automatic or derivative benchmark labels into human gold. Stages 1–3
ran under the strict all-gates rule (no winner); Stage 4 runs under the
revised rule recorded in its section and selects `claude-p` + `tiered_check`
as the recommended experimental lane, still off by default.

## Decision rule

Do not ship a grounding arm merely because it emits valid JSON, attaches a
source, improves answer overlap, or receives a favourable model-judge label.
Promote only a strict measured win that:

1. preserves every meaning-critical attribution, condition, date, quantity,
   exception, and modality from the answer it is checking;
2. renders no material proposition that the cited exact passage does not
   support in context;
3. does not reduce answer coverage or task correctness on sufficient evidence;
4. retains exact source IDs, passage text, hashes, versions, locators, and
   deterministic links;
5. works with held-constant Claude Sonnet and Codex calls without provider-only
   schema failures;
6. has acceptable paired latency and token cost; and
7. passes the deterministic citation/link UI and backend invariants.

If no arm meets all gates, leave the experiment off and report no winner.

## Fixed protocol

The comparison holds model, effort, question, exact passages, message content,
answer instructions, scoring, and case order constant within each paired arm.
The intended real-call matrix is:

- models: `claude-p:claude-sonnet-4-6` and `codex:gpt-5.6-sol`;
- effort: `low`;
- jurisdictions and source classes: Canadian case law, Canadian legislation,
  U.S. case law, and U.S. legislation;
- ordinary and adversarial Canadian Semantic LegalBench examples;
- an opinion-derived CLERC continuation;
- a direct-support HousingQA item and a deliberately weak-reference HousingQA
  item, whose benchmark answer remains visible but is not treated as proof that
  the supplied passage entails the answer;
- targeted invariant probes for lost attribution, omitted conditions, changed
  modality, unresolved ambiguity, incomplete support, a wrong source, and
  partial or unnecessary citations.

Raw prompts, outputs, usage, latency, failures, and evidence receipts are first
written under the OS temporary directory, then the six retained receipts are
archived under the OpenLegalData AppData contract documented below. The
repository retains only aggregate findings and small non-corpus regression
fixtures. A benchmark target is labelled by its actual provenance
(`benchmark_target`, `opinion_derived_continuation`, or
`expert_annotated_answer`), never silently promoted to human-reviewed support
gold.

Scores remain separate:

- task correctness or target overlap;
- contextual meaning preservation;
- source-passage entailment;
- answer coverage;
- citation completeness and necessity;
- deterministic reference validity;
- authority/current-law validation;
- provider/tool reliability;
- latency and input/output tokens.

The source-passage gate is not replaced by comparison to a reference answer.
Authority and current-law validation are also independent of passage
entailment.

## Primary implementation reread

The following code, prompts, appendices, and paper sources were reread before
Hypothesis 1 was frozen. Repository revisions identify the inspected source,
not a Beaver dependency.

| Work | Inspected implementation | What the term or code actually does |
| --- | --- | --- |
| FActScore | [`shmsw25/FActScore`](https://github.com/shmsw25/FActScore), `f28272deffcf33efc1f1117d5479c10bb75221a9` | Its prompt calls an atomic fact one sentence containing a singular piece of information. The code sentence-splits, decomposes with examples, and post-processes. The primary score is factual precision; response rate and fact count are only loose recall indicators. This does not establish a complete-answer schema. |
| SAFE | [`google-deepmind/long-form-factuality`](https://github.com/google-deepmind/long-form-factuality), `9d27158d198ced0a9d8271a80147cae580614601` | Relevance is a separate classification. A distinct revision prompt resolves vague references from response context while forbidding new or changed facts. Self-containment is therefore not synonymous with atomicity or support. |
| ALCE | [`princeton-nlp/ALCE`](https://github.com/princeton-nlp/ALCE), `246c476a4edfc564266b7346b6e29ef4861ae937` | The evaluator sentence-splits answers, validates bracketed citation IDs, checks joint cited passages against the sentence, and tests whether individual citations are necessary by single-source and leave-one-out entailment. It does not decompose every sentence into atomic facts. |
| WiCE | [`ryokamoi/wice`](https://github.com/ryokamoi/wice), `ddeb6c183665e2a20c5f03c5aa07f03888b9870f` | The released prompt says to segment a sentence into individual facts. The paper reports separate manual completeness/correctness validation and manual correction of decomposition errors in evaluation data. A structured response alone is not that validation. |
| RefChecker | [`amazon-science/RefChecker`](https://github.com/amazon-science/RefChecker), `1df1b25cee792ba2b171302e31ca4f768bd67703` | Its extraction prompt separately requires a fine-grained knowledge point, self-containment, faithful reflection of the response, completeness, and preserved conditions/attributes. Extraction does not decide truth. Its checker classifies entailment, contradiction, or neutral against the reference. |
| RAGChecker | [`amazon-science/RAGChecker`](https://github.com/amazon-science/RAGChecker), `6091f08c00e676e87a970f2aeb4a23a484746348` | The implementation keeps answer correctness/recall, retrieval claim recall/context precision, faithfulness, hallucination, self-knowledge, and noise sensitivity as distinct diagnostics. Source faithfulness is not answer correctness or completeness. |
| Ragas | [`explodinggradients/ragas`](https://github.com/explodinggradients/ragas), `298b68274234c060deacab3cf5fb52aa3a20e885` | `FactualCorrectness` exposes independent low/high atomicity and low/high coverage prompt settings. The examples, rather than the Pydantic/JSON schema, encode their semantics. The inspected defaults are low atomicity and low coverage. |
| Claimify | [paper](https://arxiv.org/abs/2502.10855) and released arXiv prompt source; no official public implementation located | It explicitly evaluates entailment, coverage, and decontextualization, and declines to optimize atomicity because the endpoint is unclear and gains are inconsistent. Its stages are selection, disambiguation, and decomposition after sentence/context preparation. Unresolvable ambiguity is excluded. The selection ablation is the largest reported loss. |
| Closer Look at Claim Decomposition | [paper](https://arxiv.org/abs/2403.11903); no official repository located | It separates atomicity, coverage, and coherence, and shows that decomposition error can be misattributed to the answer generator. More subclaims are useful only when they remain coherent and supported by the original. |
| Rethinking Atomic Decomposition for LLM Judges | [paper/source](https://arxiv.org/abs/2603.28005); the source says code and outputs are to be released upon acceptance | In matched single-prompt tests, a holistic judge matched or beat self-decomposing atomic judges on completeness-sensitive datasets and used fewer output tokens; a schema-matched ablation did not recover the atomic judge. It does not test externally supplied multi-stage decompositions. |
| CanLegalRAGBench | [`NLP-UBC/CanLegalRAGBench`](https://github.com/NLP-UBC/CanLegalRAGBench), `9e72fe1429fdd5d226195be2e171792e9ba50b2d` | The official generation evaluator instantiates Ragas `FactualCorrectness(mode="precision")` with defaults and separately runs `ResponseGroundedness`. Both judge the generated answer against the human reference answer; neither is a retrieved-passage entailment gate. Its manual-eval path usefully exposes decomposed statements, verdicts, and exact prompts, but automatic labels remain judge outputs. |

This evidence does not justify describing Beaver's units as “atomic.” The
experiment therefore calls them **independently checkable support units** and
measures coverage, meaning preservation, and passage support separately.

## Beaver and ALR constraints reread

The Beaver master and evaluation plans require exact evidence and independent
metrics, not narrative-only assurances. The ALR Quote Verifier history was
inspected as design evidence without importing private modules:

- `e202c80` made SCC frame/mobile parameters load-bearing for native text
  fragments; `4ecd4f9` separated official SCC quote highlights from ordinary
  CanLII citation links;
- `afded88`, `384f03e`, and `6915dbc` cover blind fragments, quote-to-pinpoint
  recovery, and verified guards; `4fa4f26` enforces link honesty; and
  `e2f84d0` supplies the neutral-citation-to-CanLII mapping lesson;
- ordinary case citations prefer confidently constructed CanLII links;
- a verified SCC quote can use the official Decisia decision page for a native
  paragraph and text-fragment highlight while the ordinary case citation still
  uses CanLII;
- the SCC quote URL must replace existing `iframe` and `site_preference`
  parameters with `iframe=true&site_preference=mobile`; the mobile flag is
  load-bearing browser behaviour, not a server-detectable fallback;
- fragments, paragraph pinpoints, quote recovery, and URL construction are
  deterministic machinery, not model prose;
- one complete legal citation becomes one link/pill; partial citation links are
  forbidden.

Beaver already ports only the small neutral CanLII mapping and URL behaviour,
with attribution, and keeps ALR independent.

## Precursor smoke — not an experiment result

The pre-registration smoke receipt is private at
`%TEMP%\beaver-legal-grounding\smoke-contextual.jsonl`. It does not count as
Stage 1 because the hypothesis was not frozen first and one provider rejected
the schema.

- Codex control returned a transient server error after 67.5 seconds.
- Codex structured output failed immediately because its strict tool schema
  rejects `uniqueItems`. Beaver removed that keyword and retains deterministic
  duplicate-ID rejection in ordinary code.
- Claude control completed in 7.3 seconds.
- Claude `compose_check` completed in 10.8 seconds with one checker call and
  marked the answer passed.

The pass was substantively wrong. The only supplied Alabama passage was the
definition of “premises” in `ALA. CODE § 35-9A-141(11)`. The answer claimed
that Alabama has a statute regulating residential evictions and that the
definition establishes an eviction framework. The checker labelled the broad
claim `preserved`, `supported`, and coverage `complete`, even though the exact
passage does not entail it. Exact IDs and hashes made the error auditable but
did not prevent it. Likely failure classes are weak reference selection,
parametric-knowledge leakage, and an over-trusting same-model checker.

That failure is now an explicit Stage 1 falsification probe.

## Stage 1 — direct composition plus contextual passage check

### Frozen Hypothesis 1

Given the same question and exact passages, requiring the answer model to submit
independently checkable support units with evidence handles, followed by one
separate same-model check that independently classifies contextual meaning,
source support, and coverage, will reduce unsupported rendered propositions and
citation failures relative to the ordinary control without reducing task
correctness or answer coverage on sufficient passages.

This is a hypothesis about workflow and exact receipts, not about JSON Schema
causing truth.

### Predictions

- Both providers accept the deliberately small strict schemas after removal of
  unsupported keywords; duplicate handles still fail deterministically.
- Every rendered structured unit has at least one registered exact-passage
  receipt and no invented evidence ID.
- Lost attribution, omitted conditions, changed modality, and unresolved
  ambiguity are rejected as `changed` or `ambiguous`, independent of passage
  support.
- Wrong-source, partial-support, and the weak Alabama eviction claim are
  rejected as `contradicted` or `insufficient`.
- A sufficient direct HousingQA statute keeps the correct yes/no answer.
- Structured answers have complete inline citation coverage without redundant
  citations.
- The arm costs one checker call in the pass case and therefore has higher
  latency and token use than control, but does not add an extractor call.

### Falsification and gates

Hypothesis 1 fails if any clearly unsupported material claim passes; any
meaning-critical attribution, condition, or modality changes and passes; any
provider cannot reliably call the schema; a rendered unit lacks an exact
receipt; coverage is gained only by omitting supported answer content; or task
correctness falls on a sufficient-reference pair.

The preliminary Alabama false pass already puts the hypothesis at risk. It
becomes a formal falsification only if it recurs in the frozen Stage 1 run. A
repair that merely deletes the answer does not count as a quality win unless
the passage is genuinely insufficient.

### Stage 1 result

Result: **falsified**.

The frozen rerun produced 24 cells. Claude completed all 12. Codex completed
only one of 12: ten calls returned provider overload/server errors and one
structured call hit the 90-second per-cell deadline. Codex therefore supplies
tool-compatibility evidence for the one completed adversarial cell but no
paired quality estimate. Provider errors and timeouts are not semantic
refusals.

For Claude:

| Arm | Completed | Mean / median latency | Reported output tokens | Reported cache-write input tokens | Mean target token F1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| control | 6/6 | 12.4 s / 11.6 s | 2,378 | 9,467 | 0.274 |
| `compose_check` | 6/6 | 17.0 s / 13.6 s | 2,462 | 29,183 | 0.314 |

The `claude-p` wrapper reported only 18 versus 36 ordinary input tokens, so
those counts are not treated as complete input accounting; cache-write input
and output counts are retained separately. Target F1 is descriptive, not a
grounding label.

All six Claude structured answers were schema-compliant and rendered with exact
receipts and inline citations. Five were passage-supported on manual audit.
The sixth repeated the precursor failure: the checker marked the broad Alabama
eviction-framework claim supported by a passage that only defines “premises.”
The sufficient seven-business-day row passed. Thus the structured arm's
pre-registered source-sufficiency gate was 1/2, not a strict win. More detailed
instructions, explicit separation labels, exact hashes, and a separate
same-model call did not force reference adherence.

The rerun also exposed a harness reliability defect: one slow request could
block every later cell and verifier provider errors were hidden by a generic
failure. The runner now applies a 90-second per-cell abort and records the
private finalizer diagnostic. Those changes affect measurement, not grounding
semantics.

## Stage 2 — failure-derived variant

### Failure-driven reread

The Stage 1 failure was compared with additional primary sources and exact
released prompts:

- [Judging Against the Reference](https://arxiv.org/abs/2601.07506) reports
  that judges can override a supplied reference with parametric knowledge; more
  detailed instructions, in-context examples, chain-of-thought, and
  self-consistency did not eliminate the failure. The paper is diagnostic and
  proposes no inference-time cure. Stage 2 therefore cannot be justified as a
  stronger checker prompt.
- [ContextualJudgeBench](https://aclanthology.org/2025.acl-long.470/) defines a
  refusal-and-faithfulness-first hierarchy: if context is insufficient, the
  faithful response refuses; only faithful substantive answers proceed to
  completeness and concision. It also finds limited gains from giving judges
  only the exact criterion and little benefit from juries/self-consistency.
- [GaRAGe](https://github.com/amazon-science/GaRAGe) keeps passage relevance,
  whether a passage answers the question, citation use, false premise, and
  answer validation as separate human annotations. This supports measuring
  reference admission separately from answer entailment.
- [UAEval4RAG](https://aclanthology.org/2025.acl-long.415/) evaluates
  answerable correctness and unanswerable rejection separately and reports
  configuration-dependent trade-offs; it does not establish one universal
  refusal mechanism.
- Claimify's released Selection prompt selects sentences containing specific,
  verifiable propositions before disambiguation/decomposition. Its ablation
  reports the largest coverage loss without Selection. That task does **not**
  decide whether retrieved evidence answers a question, so Beaver borrows only
  the general lesson to commit selection before later generation, not
  Claimify's label or multi-pass machinery.
- RefChecker's released checker has a claim/reference-only form and labels
  absent support Neutral. That remains a candidate for Stage 3; it is not mixed
  into Stage 2, whose independent variable is ordering and answerability
  commitment.

### Frozen Hypothesis 2

Given the same question and passages, forcing the model to commit **before
answer composition** whether the supplied passages are sufficient, and to
commit the minimal admitted evidence IDs when they are, will reject the weak
Alabama reference while retaining answers on sufficient passages more reliably
than Stage 1's compose-then-check order.

The commitment is a tiny extension of the existing `evidence_first` tool. It
has two states:

- `sufficient` requires one or more exact passage handles and permits answer
  composition only from those handles;
- `insufficient` requires no handles, terminates without answer composition,
  and renders a typed insufficient-evidence response.

The existing contextual/passage checker remains after a sufficient answer so
that the independent change is pre-answer admission and ordering, not removal
of Stage 1's safeguards. The two decisions are recorded separately. This is
not called Claimify Selection and it is not assumed to be an accuracy gain.

### Predictions and falsification

- The weak Alabama row commits `insufficient` before composing and makes no
  finalizer call.
- The directly sufficient seven-business-day row commits `sufficient`, answers
  yes, and passes passage verification.
- Ordinary Canadian/U.S. case and legislation rows remain answerable; the
  adversarial false-premise statute remains answerable only as a correction
  grounded in the supplied section.
- Both providers accept the simple schema; local validation rejects a
  sufficient decision with no handles, an insufficient decision with handles,
  unknown handles, and composition before a sufficient plan.
- Evidence-first may cost another tool iteration. It fails the efficiency gate
  if it does not improve the weak-reference decision or if its latency/token
  increase is not accompanied by a quality gain.

Hypothesis 2 is falsified if the weak Alabama row is admitted, any sufficient
paired row is rejected merely because the model is conservative, an answer
uses evidence outside the committed plan, provider reliability materially
degrades, or the same grounding failure survives the final check.

### Stage 2 result

Result: **falsified**.

The three-arm rerun produced 36 cells. Codex completed 1/6 evidence-first
cells; Claude completed 2/6. Three Claude evidence-first cells returned
unparseable multi-turn JSON after retries and one hit the 90-second deadline.
Across all six Claude cells, mean latency was 59.9 seconds and median latency
was 69.2 seconds, compared with 12.3/9.4 seconds for control in the same
batch. Completed-only timing would hide the four reliability failures and is
therefore not used as the headline.

Both completed Claude decisions were `insufficient`:

- the weak Alabama definition-only reference was correctly rejected; but
- the Canadian adversarial request about the Franchises Act was also rejected,
  even though the supplied section was sufficient to correct the false premise
  and explain the actual burden-of-proof rule.

The same false rejection occurred in Codex's sole completed evidence-first
cell. Other sufficient cells either failed in transport or timed out after a
`sufficient` plan. The precommit therefore traded one known false acceptance
for a known false rejection, severe coverage loss, an extra tool iteration,
and much worse reliability. H2 fails its answerable-coverage, efficiency, and
provider-reliability gates.

The contemporaneous Stage 1 arm was itself unstable: Claude's `compose_check`
correctly rejected the weak Alabama row on this run, after falsely accepting it
on the prior run. It needed one initial check, one repair, and one final check
(61.3 seconds). This confirms stochastic judge behaviour rather than a durable
fix.

## Stage 3 — independent variant and selection

### Failure-driven diagnosis and reread

Stage 1 shows that explicit units plus a same-model per-unit checker can
override a weak passage with parametric knowledge. Stage 2 shows that moving an
answerability decision earlier can over-refuse and makes the multi-turn
transport brittle. The measured bottleneck is not missing JSON fields. It is a
combination of reference quality, reference adherence, stochastic same-model
judging, and extra-call reliability.

The primary source for *A Matched Holistic Rubric Rivals Self-Decomposing
Atomic Judges* was reread with its exact prompt appendix and ablations. Its
scope is narrow: single-prompt benchmark-style reference-support
classification, not Beaver's multi-stage product pipeline. Within that scope:

- the holistic judge receives the same question, reference, and candidate;
- it evaluates correctness, completeness, unsupported detail, and style bias
  without decomposing;
- the schema-matched ablation did not recover atomic accuracy;
- holistic matched or exceeded the self-decomposing judge on ASQA/QAMPARI and
  used fewer tokens, with the advantage concentrated in partial-support cases;
- both families remained highly sensitive to bad references; and
- externally supplied decompositions and multi-stage systems were not tested.

ALCE's released evaluator was reread separately. It first checks whether the
joint cited passages entail a citation-stripped sentence. For a jointly
supported sentence with multiple citations, it then tests each passage alone
and, if that fails, removes that passage to determine whether it was necessary.
Citation recall/necessity is therefore a separate diagnostic, not part of the
holistic support verdict.

### Frozen Hypothesis 3

Given the same question, exact passages, and structured candidate answer, one
matched **whole-answer** support classifier will reject unsupported or
partially supported answers at least as reliably as Stage 1's per-unit checker,
while producing fewer tokens and avoiding Stage 1's repair loop and Stage 2's
pre-answer tool iteration.

The `holistic_check` arm keeps exact passage handles and deterministic
rendering, but its checker returns only one of:

- `supported`: every material assertion is attributable to the passages and
  the answer covers the answerable substance of the request;
- `partially_supported`: the answer mixes supported content with an
  unsupported material assertion or materially omits answerable substance;
- `unsupported`: the passages do not support the answer.

Only `supported` renders. There is no repair pass. This is the deliberately
token-cheaper matched holistic alternative; it is not described as an atomic
or claim-decomposition system. Contextual meaning preservation is not a
rewrite problem in this arm because the checker receives the exact submitted
answer. Authority/current-law validation remains separate.

### Predictions and falsification

- Both weak Alabama trials are rejected without repair.
- The direct seven-business-day statute, ordinary Canadian case/statute,
  adversarial premise correction, and U.S. case continuation are accepted when
  their passages support the rendered answer.
- The checker uses exactly one call after structured composition and emits a
  materially smaller result than Stage 1's per-unit array.
- Tool compliance and completion rate are no worse than `compose_check`.
- Exact receipts and deterministic inline links remain unchanged.
- Separate targeted probes detect lost attribution, omitted conditions,
  changed modality, ambiguity, incomplete support, wrong sources, and
  partial/unnecessary citations. ALCE-style necessity is reported separately
  from the answer support verdict.

H3 is falsified by any weak-reference false pass, any supported paired answer
being rejected, unreliable schema/transport, no realized token reduction, or
any deterministic receipt/link regression.

### Stage 3 implementation

The provisional `holistic_check` arm uses the existing exact evidence
receipts and structured answer submission. It adds one strict
`verify_grounded_answer` call with only the three frozen verdicts. The checker
receives the question, exact submitted answer, and exact cited passages. It
does not extract or rewrite units, does not repair the answer, and does not
consult outside knowledge. `partially_supported`, `unsupported`, a malformed
verdict, timeout, or provider error all fail closed. The feature remains
experimental and off by default.

### Stage 3 result

Result: **falsified; no experiment is promoted**.

The held-constant matrix again contained the same six items: an ordinary
Canadian case, ordinary Canadian legislation, a Canadian false-premise
legislation item, a U.S. case, a directly sufficient U.S. statute, and the
weak definition-only Alabama reference. Each arm received the same question,
passages, model, and low effort.

For Claude:

| Arm | Completed | All-cell mean / median latency | Reported output tokens | Reported cache-write input tokens | Mean target token F1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| control | 6/6 | 8.91 s / 7.82 s | 1,891 | 9,471 | 0.300 |
| `compose_check` | 5/6 | 24.00 s / 13.35 s | 3,021 | 34,702 | 0.335 |
| `holistic_check` | 6/6 | 24.75 s / 16.15 s | 2,131 | 19,635 | 0.354 |

Token totals include completed cells only; latency includes every cell so a
transport failure is not erased. As before, Claude's reported ordinary input
count is not complete accounting and is retained separately from cache-write
and cache-read input.

The holistic arm accepted all five answerable Claude cells and rejected the
weak Alabama cell as `partially_supported`. The independent weak-reference
probe also rejected that passage. It therefore fixed both pre-registered weak
reference trials in this run. It used 29% fewer output tokens and 43% fewer
cache-write input tokens than `compose_check`, and avoided that arm's one
malformed multi-turn reply. It was nevertheless slower at both the mean and
median, so it was not a strict efficiency win.

Codex prevented a cross-provider result. It completed 2/6 control cells,
0/6 `compose_check` cells, and 1/6 holistic cells. The one nominal holistic
completion contained no verifier verdict because the finalizer itself received
a provider-overload error and therefore rendered the generic fail-closed
response. Other cells returned overload, server, stream-abort, or timeout
errors. These are transport failures, not semantic refusals, and they satisfy
H3's unreliable-transport falsification condition.

The fixed verifier-only suite removed answer generation and exercised eleven
meaning and citation cases:

- Claude returned 11/11 verdicts in a mean 3.86 seconds. It matched the exact
  three-way label on 10/11. The disagreement was a lost-attribution/scope
  claim labelled `partially_supported` rather than `unsupported`; both labels
  fail closed, so its allow/deny decision was correct on 11/11.
- It rejected omitted conditions, changed modality and time, unresolved
  ambiguity, invented partial support, the weak reference, and the wrong
  source. It accepted the supported control.
- The ALCE-style joint, correct-only, and irrelevant-only sequence accepted
  the first two and rejected the last, correctly identifying that the second
  citation in the joint set was unnecessary. Citation necessity remains a
  separate diagnostic.
- Codex returned only 5/11 verdicts. All five exact labels matched, but six
  provider failures make that result unusable as a default gate.

The experiment demonstrates a useful token-cheaper verifier shape for Claude,
not a production winner. The sample is small, benchmark targets and fixed
probe expectations are derivative rather than human gold, the same-model
verdict is stochastic, and neither authority rank nor current-law validity was
tested. A valid exact-passage receipt proves what text was checked, not that
the source is controlling, current, or complete. The simplest
evidence-supported product decision is therefore to keep deterministic
evidence receipts, hashes, pinpoints, source links, and fail-closed rendering,
but leave every model-judge experiment off.

## Stage 4 — revised decision rule and tiered verification

### Revised decision rule (2026-07-30, post-Stage-3 direction)

The Stage 1–3 rule demanded a strict win on every gate including paired
latency/token cost against the UNVERIFIED control — a gate no verification
arm can pass, because verification is an extra call by construction. The
directive for this stage is explicitly weaker: **reasonably grounded
answers without unreasonable token spend**. Stage 4 therefore promotes an
arm that:

1. preserves Stage 3's weak-reference rejections (both Alabama trials and
   the fixed probe) and adds no new false accepts on the probe suite's
   allow/deny decisions;
2. renders every answerable paired cell that Stage 3's holistic arm
   rendered;
3. spends fewer checker calls/tokens than always-holistic on
   quote-anchored answers, and never more than one checker call per cell;
4. completes cells under transient provider failure where a single
   unretried call would have errored;
5. keeps exact receipts, hashes, deterministic links, and fail-closed
   rendering unchanged.

Perfection gates that remain out of scope, stated so they are not
silently claimed: coverage on the deterministic path is NOT judged (the
receipt records it `not_run`); stochastic same-model judging is bounded,
not eliminated; authority/current-law validation stays separate and
untested; a verbatim quote can still be wrenched out of context — the
same residual risk the product's quote-only lane already accepts.

### Failure-driven reread

The Stage 1–3 evidence, reread against the cost question: the holistic
arm's whole spend increase is re-sending passages plus answer to one
checker; its whole quality win came from judging the answer as submitted,
fail-closed. The verification-cascade literature (run a cheap check on
all traffic, escalate flagged cases) maps onto Beaver without any new
model: Beaver's cheap tier should be its own deterministic quote
machinery — the ALR-heritage trust anchor — not a second LLM. Small
grounded-factuality verifiers (MiniCheck / Bespoke-MiniCheck, the
LLM-AggreFact line) remain a candidate local escalation tier but are
deliberately out of this stage's scope: no local runtime is installed,
and the direction is not about any particular model. Sources:
[MiniCheck](https://arxiv.org/abs/2404.10774),
[LLM-AggreFact leaderboard](https://llm-aggrefact.github.io/blog),
cascade framing per production hallucination-detection guidance
([Noveum](https://noveum.ai/en/blog/hallucination-detection-production-ai-agents),
[Lakera](https://www.lakera.ai/blog/guide-to-hallucinations-in-large-language-models)).

### Frozen Hypothesis 4

Given the same question and exact passages, a tiered verifier — a
deterministic verbatim-quote tier that lets fully-quoted answers render
with zero checker calls, escalating everything else to Stage 3's single
holistic check hardened with bounded transport retries — combined with a
composition instruction preferring exact quotation for material
propositions, will satisfy every revised-rule gate above.

The deterministic tier: strip balanced trailing citation parentheticals
and surrounding quote marks; normalize whitespace, curly quotes, dash
widths, NBSP, and ellipsis (never case, never words); the claim body must
be at least 25 characters and a contiguous substring of ONE cited
passage. Splices, mutations, prose framing, and paraphrase all escalate.
Retries: at most three holistic attempts per cell, only on
transport-class failures (provider overload/server error, stream aborts,
malformed no-verdict replies); semantic verdicts are never retried; the
per-cell deadline still governs.

### Predictions and falsification

- The pure-quote probe passes with zero model checker calls.
- The mutated-quote probe (business → calendar days inside quotation
  marks) and the spliced-prose probe do NOT clear the deterministic tier
  and fail closed after escalation.
- Both weak Alabama trials still reject; every answerable cell the
  holistic arm rendered still renders.
- The tiered arm's checker calls per cell are ≤ 1 with strictly fewer
  checker tokens than always-holistic across the matrix when any cell
  clears deterministically.
- Existing probe-suite allow/deny decisions are unchanged under the
  tiered mode's escalation path.

H4 is falsified by: any false pass through the deterministic tier
(mutation, splice, paraphrase, weak reference); any answerable paired
cell lost relative to holistic_check; checker spend not reduced on
quote-anchored cells; or a reliability regression attributable to the
retry machinery.

### Stage 4 result

Result: **H4 falsified as frozen; the Claude lane of the tiered arm is
nevertheless the first configuration in four stages to clear every
revised-rule quality gate in a single run.** The pre-registration is
commit `b0338f65`; the matrix ran under the bounded pool (concurrency 4,
per-model cap 2), which changes wall-clock only.

Probe suite (14 probes × 2 providers): Claude matched 13/14 exact labels
and 14/14 allow/deny decisions — the sole label disagreement is the same
fail-closed lost-attribution `partially_supported`-vs-`unsupported` from
Stage 3. All three new deterministic probes behaved as predicted on BOTH
providers: the pure quote passed with zero model calls, the mutated
quote (business → calendar days inside quotation marks) and the spliced
prose refused the deterministic tier, escalated, and failed closed.
Codex matched 11/14 with three transport nulls confined to the
retry-less holistic-mode probes; its tiered-mode probes, which carry the
retry harness, all completed. ALCE leave-one-out necessity matched on
both providers.

Held-constant matrix (same six items as Stage 3, same CLERC row), for
Claude:

| Arm | Completed | Mean / median latency | Output tokens | Cache-write input | Housing support gate | Answerable cells rendered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| control | 6/6 | 10.0 s / 8.3 s | 2,000 | 9,464 | — | — |
| `holistic_check` | 6/6 | 12.2 s / 11.1 s | 2,103 | 22,697 | 0/2 | 4/5 |
| `tiered_check` | 6/6 | 13.5 s / 13.1 s | 2,163 | 23,006 | **2/2** | **5/5** |

The same-run `holistic_check` arm flipped BOTH housing decisions wrong —
it false-accepted the weak Alabama reference (third occurrence across
runs) and falsely rejected the sufficient seven-business-day row —
further confirming stochastic same-model judging. The tiered arm, whose
only semantic delta upstream of the identical checker is the
quote-preferring composition instruction, rejected the weak reference
and rendered every answerable cell; its single failure is that correct
rejection. Cost against control: one checker call per cell, +8% output
tokens, ~2.4× cache-write input, +3.5 s mean.

Codex completed all 18 non-control cells this run (the prior stages'
overloads were transient provider weather, not schema failures), but its
tiered lane falsely rejected the sufficient housing row that its
holistic lane accepted — an answerable-cell loss.

H4's frozen falsification clauses therefore trip on two points, stated
plainly: (1) an answerable paired cell was lost relative to
`holistic_check` on the Codex lane; (2) matrix-wide checker spend was
not reduced, because composition never produced a fully-quoted answer —
the zero-call deterministic path fired only in the probe, and the two
claims that cleared the tier inside mixed answers were verified genuine
verbatim quotes (no deterministic false pass anywhere, matrix or
probes).

Promotion decision under the revised rule: `claude-p` + `tiered_check`
is the recommended experimental grounding lane — reasonably grounded at
roughly one extra small call per answer — but the flag stays off by
default. Two things gate a default-on decision, and they are the next
stage's independent variables: composition must quote-anchor firmly
enough that the zero-call deterministic path carries real answers (the
same-run holistic-vs-tiered housing divergence suggests quote-anchored
composition also stabilizes the judge), and the Codex lane stays
disqualified as both composer and checker. Authority and current-law
validation remain untested, as before.

## Stage 5 — scale and the model-trust control

### Motivation

Stage 4's decisive cells number six, and every grounding decision was
made by the composing model's own family. Two confounds follow: small-n
(a lucky run clears gates), and model trust (the wins may reflect the
composer/checker model being inherently more reliable at legal text
rather than the harness). Stage 5 scales the held-constant matrix 4×
and crosses the checker model against the composer, so the harness
effect and the model effect separate.

### Frozen Hypothesis 5

Stage 4's grounding behaviour on the tiered arm is attributable to the
harness — quote-preferring composition, the deterministic verbatim tier,
and one fail-closed holistic escalation — and not to the composing
model's inherent legal reliability. Concretely, on a 24-item
held-constant matrix (12 CSLB: 4 ordinary case / 4 ordinary legislation
/ 4 adversarial; 4 CLERC continuations; 8 HousingQA rows — the audited
163/0 sufficiency pair plus six unaudited rows balanced yes/no across
states, ids 286, 1, 57, 595, 290, 605):

- (a) within EACH composer model, `tiered_check` preserves answerable
  coverage relative to control (excluding correct insufficient-evidence
  rejections) and keeps the audited pair correct for the Claude
  composer;
- (b) crossing the checker (Claude compositions checked by Codex and
  vice versa) does not flip the audited pair to a false accept, and
  same-vs-crossed verdicts agree on a majority of completed cells —
  i.e., the checker's model family is not load-bearing for the
  grounding decision;
- (c) the deterministic tier's clears remain verified-verbatim under
  audit at scale, with no false pass;
- (d) unaudited HousingQA rows are scored on expected-answer match and
  rendering only — their benchmark labels are NOT treated as
  sufficiency gold.

### Predictions and falsification

- Weak Alabama (housing:0) rejects under every structured cell that
  completes, regardless of checker family; sufficient housing:163
  renders for the Claude composer under both checker families.
- Same-model and crossed-checker pass/fail decisions agree on most
  completed cells; disagreements are fail-closed (a rejection where the
  other accepted), never a new false accept on the audited pair.
- Within-composer answerable rendering: tiered ≥ control minus correct
  rejections; adversarial CSLB rows keep the premise-correcting shape
  (F1 comparable to Stage 4's adversarial cells).
- Deterministic clears audit as genuine verbatim quotes; the zero-call
  path may fire on some quote-heavy cells but is not required at scale.
- Error rate under the bounded pool stays under 10% of cells; the pool
  changes wall-clock only.

H5 is falsified if the crossed checker false-accepts the weak
reference for either composer; if answerable coverage under tiered
drops below control within a composer beyond correct rejections; if
any deterministic clear fails the verbatim audit; or if the harness
effect vanishes at scale (tiered's grounding decisions no better than
control while still spending checker calls).

Execution notes, frozen with the hypothesis: bounded pool (concurrency
4, per-model cap 2 keyed on the composer; a crossed cell's checker call
may transiently exceed the checker model's lane cap — accepted, the
checker call is one small request). The unaudited HousingQA rows'
sufficiency is unknown by design; only the audited pair gates.

### Stage 5 result

Result: **H5 substantially supported; no falsification clause tripped.
The grounding decisions are harness-caused, not model-trust-caused.**
144 cells, 3 errors (2.1%). Pre-registration is commit `29bc7e6f`.

Audited housing pair (163 sufficient / 0 insufficient), by lane:

| Composer | Checker | housing:163 | housing:0 | Pair |
| --- | --- | --- | --- | ---: |
| Claude | Claude (same) | rendered | rejected | 2/2 |
| Claude | Codex (crossed) | rendered | rejected | 2/2 |
| Codex | Claude (crossed) | rendered | rejected | 2/2 |
| Codex | Codex (same) | falsely rejected | **falsely accepted** | 0/2 |

The decisive pattern for the model-trust question: quote-anchored Claude
compositions were judged correctly by BOTH checker families — even the
checker family that fails the pair on its own compositions — and Claude
checking rescues Codex compositions completely. The run's only false
accept required Codex in BOTH roles. Crossing the checker never
introduced a false accept anywhere (frozen prediction held), so the
checker's model family is not load-bearing once composition is
quote-anchored; the harness carries the decision. Codex is also not
simply "worse at legal" — its control target-F1 (0.40) beats Claude's
(0.29) — the crossing isolates grounding-decision reliability from raw
capability.

Same-vs-crossed pass/fail agreement on tiered cells: 35/47 pairs agree;
11 of the 12 disagreements are fail-closed (crossed checker rejecting
what same-model accepted) and the twelfth is the crossed Claude checker
FIXING Codex's false rejection of the sufficient row. No disagreement
produced a false accept.

Deterministic tier at scale: 17 claims cleared across the matrix; all
17 re-audited against the lib's actual tier logic as genuine verbatim
quotes — zero false passes (an initial 2-failure count came from the
analysis script's cruder normalization and did not survive the lib
re-audit). The zero-checker-call path fired on three REAL cells for the
first time — all Codex compositions, which quote more fully than
Claude's; Claude compositions still never clear a whole answer, so its
checker-call saving remains unrealized.

Coverage per composer: Codex-composed tiered with same-model checking
rendered 23/24 against a 22/24 control (but that includes the false
accept); with the Claude checker, 20/24 plus correct rejections. Claude
same-checker tiered rendered 19/24 plus the audited-correct weak
rejection; the four remaining rejections are all fail-closed
`partially_supported` verdicts on unaudited cells, and inspection shows
two of them (housing:1, housing:57) repeat the exact audited
weak-reference overreach shape — a broad "the state has a statutory
eviction framework" claim resting on one narrow provision. They are
recorded as fail-closed conservatism pending human audit, not as proven
coverage loss and not as confirmed wins; gate (a) is met under that
classification and is the one conditional element of this result.

Lane economics (completed cells, medians): control 5.7–9.4 s; tiered
12.7–15.3 s with exactly ≤1 checker call per cell throughout.

Standing conclusions after five stages: promote nothing to default-on
yet, but the recommended experimental lane is now **quote-anchored
tiered composition with a Claude-family checker, composer either
family**. The two open levers are unchanged: firmer quote-anchoring for
Claude compositions so the zero-call path fires (Codex compositions
prove it fires on real answers), and authority/current-law validation,
which no stage has touched.

## Durable receipts

The experiment JSONL receipts are outside git under
`%LOCALAPPDATA%\OpenLegalData\experiments\legal-grounding\2026-07-30`.
They contain model outputs and exact benchmark evidence and must not be
committed.

| Receipt | SHA-256 |
| --- | --- |
| `smoke-contextual.jsonl` (precursor) | `B3F1F9F620152F19DF777C3596CD91B1E5A2271C6D65642EC49572CB65BCFAD3` |
| `stage1-h1.jsonl` (superseded partial run) | `139237AC8A6EE035CE51536334A4C46D79AD80E4D5AF026F64007D012C751E50` |
| `stage1-h1-rerun.jsonl` | `93788826C9BC355B9B398A0BE25FE9B4AFBC4AEB8E2C48091F3D9DB0F2D12A7E` |
| `stage2-h2.jsonl` | `D9F6917D9AC2DE1AE01F244FCBAF19CDE9AC3F6A53800B32BB280D340CACD575` |
| `stage3-h3.jsonl` | `D0483C99D3FBD1A607538BFD6855B07E35B43400B5773181859E6BB6CE6C160B` |
| `stage3-verifier-probes.jsonl` | `2D7128D41424AC93ED02B01A7D7F473EB7A95D97BC81AAA95F76CA7B2C5823FA` |
| `stage4-verifier-probes.jsonl` | `C5B2A0CF16051CF6579C5C06CA9B1CE7EA13E06B85EC3B5234436EFF36C5DFFA` |
| `stage4-h4.jsonl` | `13C6859455021AFC2B6E9E94AFCF1EB76A0901386E49E26BD18C6B9343D0C69E` |
| `stage5-h5.jsonl` | `1690AD59C6660EB11D25D19EBA242E00F522CB0DCF010278D34DD09145D6951B` |

## Validation and final selection gate

- Backend: 1,190 tests passed, 8 skipped; TypeScript build passed.
- Frontend: 287 component/unit tests and 3 live-build guard tests passed;
  exact-source TypeScript passed; the default Next 16.2.6 Turbopack
  production build passed.
- Focused deterministic checks passed for complete neutral citations and
  paragraph ranges, CanLII-first case links, SCC quote highlights with
  `iframe=true&site_preference=mobile`, exact receipt hashes, unknown and
  duplicate evidence handles, fail-closed verifier results, and accessible
  complete case and legislation citation pills.
- Launcher smoke passed for backend health, frontend, Library, model catalog,
  and Table of Authorities. Beaver was restarted through its launcher with all
  three services owned and ready.
- No dependency was added. The experiment flag remains blank by default.
  Model traces and receipts are absent from the worktree.
- A live-browser screenshot was not captured because the in-app browser
  connection was unavailable. The pill's accessible name, link boundary,
  focus-visible style, and ordinary-link non-regression were verified directly
  in the rendered component test instead.

No arm satisfies every pre-registered quality, coverage, latency, token, and
provider-reliability gate. The final selection is therefore **no winner**.

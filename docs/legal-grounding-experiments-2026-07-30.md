# Legal grounding experiment log — 2026-07-30

Status: **completed benchmark experiment; not production-validated**. The
model-checking experiment is off by default. The deterministic composition
contract is now production wiring: after an exact A2AJ passage lookup, each
support unit's evidence receipt supplies its complete citation and locator,
and Beaver places the linked citation at that unit boundary without parsing
model citation prose. This does not promote any stochastic verifier result.
This log owns the hypotheses, fixed comparisons,
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

## Stage 6 — the quote-first composition contract

### Frozen Hypothesis 6

The remaining grounding failures and unrealized savings are
composition-shaped, not verification-shaped. Requiring the composer to
build answers from exactly two claim kinds — verbatim quotation claims
(exact passage text) and at most one conclusion claim (the direct
answer, asserting nothing beyond what the quoted text establishes, with
framing/characterization like "the state has a statutory eviction
framework" banned unless quoted) — will, under the UNCHANGED tiered
verifier, raise deterministic-clear rates, eliminate the
overreach-shaped rejections, and preserve every audited grounding
decision. The contract is enforced DETERMINISTICALLY at submission: the
tool rejects any answer with more than one non-verbatim claim (the same
tier that later renders quotes checker-free), naming the offending
claims so the model requotes; composition gets one extra tool
iteration. Claims carry no citation text under the production
citation-placement wiring; Beaver places citations from evidence
receipts.

Evidence basis: every remaining failure in Stages 1–5 is an
overreach-framing failure (the Alabama false accepts; Stage 5's
housing:1/57 rejections repeat the same shape); composition discipline
is the proven lever (Stage 4's quote preference flipped both housing
gates; Stage 5 showed quote-anchored compositions were judged correctly
by both checker families); the zero-call path is proven but starved
(all 17 deterministic clears verbatim; all three zero-call cells were
Codex compositions). Literature: According-to prompting / QUIP-Score
(more quoting, fewer hallucinations, incl. US legal text), LLMQuoter's
quote-first-then-answer, the extractive-abstractive verifiability
trade-off, Copy-Paste hallucination mitigation.

### Design, predictions, falsification

41 held-constant items (the actual selection at per-source 8): 21 CSLB
(8 ordinary case, 7 ordinary legislation, 6 adversarial — the
validation split's full stock of the latter two), 8 CLERC
continuations, 12 HousingQA rows (audited 163/0 pair + ids 286, 1, 57,
58, 5, 354, 356, 590, 595, 290 unaudited, five yes / five no). Arms
control, tiered_check, quote_first × composers Claude and Codex,
Claude-family checker throughout (Stage 5's recommended lane) — 246
cells, bounded pool 4/2.

Predictions: audited pair correct in every quote_first lane; Claude
zero-checker-call cells go 0 → >0 and per-claim deterministic-clear
rate rises materially; quote_first renders at least as many answerable
cells as tiered_check (the overreach class specifically recovers);
submission-contract rejections are absorbed within the extra iteration
(non-submission rate does not rise materially); every deterministic
clear re-audits verbatim.

Falsified by: any weak-reference false accept; audited-pair
degradation; no deterministic-clear gain for the Claude composer;
answerable rendering below tiered_check; or contract-driven
non-submission/over-refusal materially above tiered_check's.

### Stage 6 result

Result: **H6 falsified on its coverage gates while decisively proving
its mechanism.** 246 cells, 1 transport error. Pre-registration
`25c4b6b5`.

What the hard contract proved: composition CAN quote — deterministic-
clear rates jumped from 0% (tiered, Claude) to 57% of Claude claims and
62% of Codex claims; Codex produced the first three real zero-call
cells; and all 110 deterministic clears re-audit verbatim under the lib
logic (the tier's cumulative soundness record: 127/127 across Stages
4–6, zero false passes).

What it broke, decoded per cell: both quote_first lanes lost the
sufficient housing:163 — Codex's single conclusion claim WRONGLY
refused ("The passages cannot support a direct answer") beside a
correct verbatim quote, and Claude's correct "Yes" conclusion drew a
stochastic partially_supported from the checker judging a minimal
quote+conclusion answer as incomplete. Claude's eight non-submission
cells cluster on adversarial CSLB and CLERC continuation items, where
premise corrections and multi-step analysis cannot be expressed as
quotes plus ONE conclusion claim within three iterations; its
housing:0 non-submission is the contract working (nothing quotable
supports an answer). Rendering: quote_first 23/41 (Claude) and 32/41
(Codex) vs tiered_check's 33/41 and 35/41, with tiered 4/4 on the
audited pair under the Claude checker — reconfirming Stage 5's
recommended lane at 4× the n.

Refined conclusion carried forward: hard deterministic enforcement
belongs at the CLAIM level (quotes must be real quotes — proven sound)
but not as an answer-level one-conclusion cap; the checker needs a
rubric for minimal quote-anchored answers whose "coverage" currently
reads as incomplete; and the freely-composed conclusion claim remains
the residual that H12's attested characterizations target. Stage 7
therefore ablates the SOFT contract plus deterministic lint (H13
corpus-alienness, H14 prompt-gravitation, H7 features) rather than
hard caps.

## Stage 7 — lint-gated cascade (run 2026-07-30)

### Frozen Hypothesis 7

Deterministic lint over composed claims — novel-content features (H7),
corpus-alienness against a jurisdiction-matched trigram reference
(H13), and prompt-gravitation (H14) — inserted as a SOFT pre-checker
gate in the tiered lane will (a) catch overreach-shaped framing before
the stochastic checker sees it, (b) reduce checker calls, and (c) add
zero new false accepts, because the gate can only send claims BACK for
revision with a typed feature-named rejection, never approve them.
Per Stage 6's refined conclusion this is the soft-contract path: no
answer-level caps; the deterministic verbatim tier is unchanged.

Evidence basis: source-anchored validation on RegLab expert labels —
response-level max-pooled novel_content_fraction AUC 0.829, US-indexed
unattested_trigram_share 0.781, prompt_only_share 0.635–0.652 — and the
Stage 1–6 receipts' uniform overreach failure shape. Thresholds are
smoke-calibrated (8 misgrounded responses); they are FROZEN before the
run at operating points that flag zero grounded max-pooled responses in
the RegLab validation set, and the run measures flag rates, not
accuracy claims from that calibration.

### Threshold freeze (2026-07-30, pre-run)

Executed by scripts/freeze-stage7-thresholds.ts over the archived
US-index claim features (claim_features.jsonl; archive reproduces the
recorded 0.781 max-pool AUC exactly). The strict zero-FP point is
degenerate at raw claim level — the saturating "grounded" claims are
citation fragments produced by sentence segmentation (case-name
splits, "Not Reported in F.Supp.2d" furniture, 4–11 content words) —
so the frozen operating point includes a minimum-applicability gate:
thresholded features fire only on claims with >=12 content words by
the lint's own definition (exported contentWordCount; the gate ships
inside LintThresholds as minContentWords, so composition-time behavior
is calibration behavior). At that gate, 336/537 claims are eligible
across 106 responses (94 grounded / 7 misgrounded / 5 ungrounded with
eligible claims), and the zero-grounded-flag maxima freeze at:

    novel_content_fraction   > 0.666667
    unattested_trigram_share > 0.823529   (index jurisdiction-matched)
    prompt_only_share        > 0.333333

Honest note: at these points the misgrounded/ungrounded RegLab
responses also show zero flags — the freeze buys guaranteed
conservatism on grounded material, not demonstrated sensitivity on
this n=7 validation slice. Sensitivity is what the run measures, on
composition-time claims (a different distribution from RAG-response
sentences). Shipped as STAGE7_LINT_THRESHOLDS with the lint_gated
mode: verbatim-tier claims skip lint; one typed revision bounce names
the fired features; post-bounce, fired receipts enter the checker
prompt (deterministic_lint_flags) and the receipt event (per-claim
lint array). 27/27 + 8/8 unit vectors.

### Design, predictions, falsification

The Stage 6 held-constant 41 items; arms tiered_check (control) and
lint_gated × composers Claude and Codex, Claude-family checker, bounded
pool 4/2. The lint gate runs on every composed claim pre-checker; a
flagged claim costs one revision iteration naming the feature.

Predictions: checker calls per rendered cell fall; the audited
housing:163/0 pair is unchanged; lint-flagged claims are
overreach-shaped on manual decode (not a random tax); rendering and
non-submission do not degrade materially vs tiered_check; every
deterministic clear re-audits verbatim.

Falsified by: any new false accept; audited-pair degradation; a lint
flag rate on grounded compositions high enough to depress rendering
below tiered_check; or no checker-call reduction.

### Results (2026-07-30, by amendment against the frozen predictions)

Registered run: 164/164 cells, 0 errors, receipts `stage7-h7.jsonl`
(sha in the table). Live smoke of the arm preceded the run (3 cells,
lint receipts stored on all claims, zero fired on quote-heavy
composition, no bounces).

**Checker-call reduction: FALSIFIED.** Holistic checker runs per arm:
claude-p 37 lint_gated vs 39 tiered_check; codex 39 vs 40. The frozen
falsifier "no checker-call reduction" fires. Structural reason,
visible only in the receipts: the holistic checker runs once per CELL
whenever any claim lacks deterministic support, so a claim-level lint
gate cannot reduce cell-level checker calls unless it converts ENTIRE
cells to all-verbatim — and deterministic-support rates barely moved
(codex 14/89 → 23/88 claims; claude-p 0 → 0, again composing zero
verbatim claims under either arm). The lint's economic benefit as
hypothesized does not exist at this cascade position.

**Safety envelope: every other prediction held.**
- Bounce cost: 11 cells bounced (9 claude-p, 2 codex), every one
  exactly one revision (2 submits), none abandoned — the one-bounce
  contract held and the gate approved nothing.
- Rendering: pass rates 0.85 vs 0.88 (codex), 0.66 vs 0.66
  (claude-p); token-F1 unchanged. No flag-rate depression.
- Audited pair: codex housing:163/0 verdicts identical across arms.
  claude-p housing:163 moved partially_supported → supported —
  consistent with the same cell's checker flip in Stage 8, i.e.
  checker stochasticity on that cell, recorded not excused.
- Transparency rode through: post-revision claims that still carry
  fired receipts surface them in the receipt event (2 claims).

**Flag shape: MIXED, with a discovered false-positive class.** Of the
two accepted-after-bounce claims still carrying fired receipts, one is
a PREMISE-CORRECTION claim ("The question's premise also conflicts
with the passage: section 146.10 governs recall advertising sponsors,
not muni…") — novel_content_fraction 0.69, unattested share 0.86.
Premise corrections are novel-content BY DESIGN (they contradict the
prompt using the source's distinctions); the lint's features cannot
distinguish them from overreach. This is exactly a C4 ensemble case:
a premise-correction witness (deterministic: claim negates
prompt-asserted content while citing span content) should gate or
down-weight the novel-content witnesses. Registered for the ensemble
matrix, not patched ad hoc.

**Instrumentation gap found: bounced claim text is not archived** —
receipts record the surviving revision, not the original flagged
claim, so "flags are overreach-shaped" could only be decoded for
claims still flagged after revision. Amendment for any future lint
arm: archive the pre-bounce claim text + rejection text in the run
receipt (composition-side transparency has an audit-side mirror).

Verdict: H7 falsified in its economic claim at this cascade position;
the lint retains value only as (a) revision pressure with a measured
one-bounce cost and no rendering tax, and (b) receipt transparency
into the checker prompt. Whether that value is real is now an H18
question (does surfacing witnesses improve first submissions?), and
the lint features themselves fold into protocol C4's ensemble study
with the premise-correction witness as a registered addition.

## Stage 8 — attested framing / H12 widened tier (run 2026-07-30)

### Frozen Hypothesis 8

For case-law claims, characterization ("stands for") language becomes
IMPOSSIBLE to compose freely without loss of honest coverage, by (a)
feeding forward ranked attested characterizations from
standsForProfile — citing-court prose from the 2.54M-edge citator graph
plus journal-commentary propositions from the paired footnote build —
into composition, and (b) requiring any claim with stands-for language
to clear the widened deterministic tier (verbatim membership in the
cited span OR a fed-forward attested characterization named in its
evidence_ids, receipts naming whose words are borrowed). Cases with
tier "none" profiles force passage-quotation-only answers or a typed
no-attested-characterization statement.

Infrastructure now in place and soundness-probed: standsForProfile
(court-level ranking, prose classifier, sha receipts; commentary
source with classifier gating), attestedCharacterizationReceipt +
widened-tier registration (mutation and splice probes fail closed,
19/19 lib tests), journal_commentary.sqlite (editor-verified
proposition↔authority pairs).

### Design, predictions, falsification

Case-law-heavy matrix: the Stage 6 CSLB case rows and CLERC
continuations, plus HousingQA statute rows retained verbatim as the
NO-OP CONTROL (statute claims have no stands-for path), plus a
Charlotin "Misrepresented" adversarial probe set where the contract
must be UNABLE to express the recorded misrepresentation. Arms
tiered_check and attested_framing × composers Claude and Codex, Claude
checker. Before the run, profile coverage (rich/thin/none) over the
matrix's cited cases is measured and recorded — a mostly-none matrix
defers the stage rather than diluting it.

Predictions: composed-overreach rejections fall to ~zero on case-law
cells; checker calls fall (characterization claims clear
deterministically); thin/none-profile refusals are reported as such,
not as errors; HousingQA cells are statistically indistinguishable
from tiered_check; no widened-tier false pass under the extended
mutation/splice probe family; audited decisions unchanged.

Falsified by: any widened-tier false pass; coverage collapse beyond
thin-profile refusals (attested candidates exist but composition fails
to use them); no reduction in composed overreach on case-law cells; or
Charlotin probes expressible under the contract.

### Coverage gate measurement (2026-07-30, pre-run)

standsForProfile over the ten Stage 6 CSLB case cells' cited cases:
4 rich (2012 SCC 57: 33 citers/8 candidates + commentary; 2010 NSSC
315; 2005 TCC 200; 2007 BCCA 40), 1 thin (2005 BCCA 293), 5 none (the
NSSM/NSFC small-claims rows nobody cites — the few-citers prior made
computable). Half the case cells exercise attested feed-forward, half
exercise the typed-refusal path; both are pre-registered behaviors, so
the matrix stands. CLERC cells are US-jurisdiction and profile none by
construction (the citator is A2AJ-Canadian); they join HousingQA as
H12 no-op cells until the US lane (CourtListener Parentheticals)
exists. Charlotin probe feasibility: 1,426 court-described
Misrepresented rows in the misgrounding corpus, of which 121 are
Canadian and can be probed against the live citator.

### Results (2026-07-30, by amendment against the frozen predictions)

Registered run: the Stage 6 held-constant 41-item matrix, arms
tiered_check + attested_framing × composers claude-p:claude-sonnet-4-6
and codex:gpt-5.6-sol, checker pinned claude-p:claude-sonnet-4-6,
164/164 cells, 0 errors, receipts `stage8-h8.jsonl` (sha in the table
below). The Charlotin adversarial probe set named in the design was
NOT included in this run (deferred to the queued probe work with
`--cases`); the amendment below is scoped to the matrix actually run.

Runner note: a pre-run smoke caught that the runner passed full
"name, citation, pinpoint" strings to standsForProfile, which keys
whole strings — every case cell silently degenerated to profile none.
Fixed before the registered run by extracting neutral citations with
the citator builder's own regex; every run receipt now carries an
`attested_characterizations` audit column (citation → candidate
count), so feed-forward coverage is self-reporting.

**Prediction 1 — composed overreach falls to ~zero on case cells:
CONFIRMED.** Ladder/abstraction language in submitted case-cell
claims: codex 3/42 claims under tiered_check (all escalated to the
model checker) vs 2/45 under attested_framing — and both surviving
claims cleared the deterministic tier as verbatim passage quotes
("our cases have held that…" quoted from the cited opinion itself).
claude-p: 6/30 tiered vs 0/9 attested (denominator caveat below). No
freely composed stands-for claim survived the attested arm.

**Prediction 2 — checker calls fall: CONFIRMED for codex, FALSIFIED
for claude-p.** Codex escalated-claim share dropped in every bucket
(CLERC 25/32 → 5/29; CSLB case 8/10 → 10/16; CSLB leg 24/27 → 11/25),
and three all-deterministic CLERC cells skipped the holistic checker
entirely (holistic runs 8 → 5). claude-p cleared 0 claims
deterministically in either arm on case cells — it paraphrases even
under quote-first prompting (consistent with Stage 6) — so its
checker load was unchanged.

**Prediction 3 — thin/none refusals reported as such: MIXED.** The
none-profile path never produced the typed
no-attested-characterization statement. Codex took the other
permitted branch — passage-quotation-only answers (24/29 CLERC claims
deterministically verbatim). claude-p instead FAILED TO SUBMIT on all
9 none-profile case cells (8 CLERC + cslb:adv-pss-0045): three typed
rejections each, then "The model did not submit a grounded answer."
This triggers the pre-registered falsifier "coverage collapse beyond
thin-profile refusals" — for one composer. The contract gives a
compliant path (quote the passage); claude-p did not find it within
maxIterations=3. Composer-dependent coverage collapse, not a
contract impossibility.

**Prediction 4 — HousingQA indistinguishable from tiered_check:
MECHANISM CONFIRMED, STRICT READING FALSIFIED.** The feed-forward is
a provable no-op on statutes (`attested_characterizations` empty; zero
attested receipts registered). But the arm's quote-first-flavored
system prompt alone changed composition: codex housing claims went
0/12 deterministically-verbatim under tiered to 15/27 under attested,
and 1/12 codex + 3/12 claude-p housing verdicts flipped. The prompt,
not the mechanism, is the confound; future arms that add a mechanism
should hold the composition prompt constant on control cells.

**Prediction 5 — no widened-tier false pass: CONFIRMED (weakly).**
Both deterministically-cleared ladder claims were spot-checked
verbatim in their cited spans. But the check is weak for a stark
reason: across all 82 attested-arm cells, ZERO claims cited an
attested characterization. The widened tier was never exercised live.

**Prediction 6 — audited decisions unchanged: CONFIRMED for the
audited pair.** The Stage 6-audited codex housing:163/housing:0
verdicts are identical across arms.

**Headline negative result (unpredicted): feed-forward attested
characterizations were fed, seen, and never used.** Rich-profile
cells (up to 8 candidates; adversarial cslb:adv-pss-0015 resisted the
mismatched-SCC bait, proving the candidates were read) produced zero
claims quoting a candidate — composers always preferred quoting the
passage in front of them. H12's enforcement half (stands-for language
must be verbatim-attested) did its job by SUPPRESSING composed
framing; the affordance half (borrow a citing court's words, with
attribution) was declined. Costs were real: codex input tokens 29k →
74k, latency 13.7s → 20.9s, case-cell token-F1 0.57 → 0.38.

Amendment: H12-as-suppression is validated and cheap to keep (the
widened tier plus typed rejection); H12-as-affordance needs a
different composition contract (e.g. a required characterization slot
that must name an attested candidate or the typed refusal) before it
can be evaluated at all — recorded as a candidate Stage 8b, not
pursued until the Charlotin probes and the misgrounded-positive
sample growth land. The claude-p none-profile collapse also caps
maxIterations sensitivity: the next case-law arm must include the
passage-quote-only fallback in the composer instructions verbatim.

## Stage 8b — contract shape and prompt factorization (pre-registered; run and analyzed 2026-07-30)

Stage 8 settled that the harness carries grounding and exposed that the
composition PROMPT is the under-controlled half of the harness. Stage
8b treats prompt structure as the experimental variable, one factor per
arm, frozen here before any run.

### Frozen Hypothesis 15 — contract shape determines affordance uptake

Stage 8's attested candidates were offered but optional, and uptake was
zero: quoting the passage always sufficed. H15: uptake is a property of
the contract, not the model — a REQUIRED characterization slot changes
it. Arm `attested_slot`: when the prompt asks what a case stands for
(deterministic trigger on the question, recorded per cell), the
submission must contain exactly one characterization claim that either
(a) verbatim-quotes an attested candidate naming its evidence_id, or
(b) is the typed no-attested-characterization statement. Free
paraphrase is not a legal value for the slot; other claims keep the
Stage 6 quote contract. Predictions: widened-tier clearances > 0 on
rich cells; attribution renders from receipts; typed statement appears
on none cells. Falsified by: degenerate slot-filling (an irrelevant
candidate quoted to satisfy the slot — audited + checker-visible),
coverage collapse on rich cells, or slot compliance below the
tiered_check pass rate on the same cells.

### Frozen Hypothesis 16 — bounce-time guidance removes composer collapse

CORRECTED PRE-RUN (2026-07-30): the first registration of this
hypothesis claimed the fallback path "was not stated." Rereading the
Stage 8 arm prompt shows it WAS stated, once, in the system prompt
("if none is supplied for that case, either quote the passage itself
or state exactly that no attested characterization is available").
claude-p collapsed anyway, 9/9. The revised hypothesis is therefore
about guidance PLACEMENT, not existence: system-prompt instructions
issued before composition are not retrieved at rejection time. H16′:
restating the compliant path inside the typed rejection text itself
("this claim characterizes the case; quote the passage verbatim or
state that no attested characterization is available") restores
coverage — the minimal form of H18's transparency principle applied
to error messages. Prediction: claude-p none-profile non-submission
9/9 → ≤1/9, zero new false accepts, no change on rich cells.
Falsified by persistent collapse under bounce-time guidance (which
would implicate iteration budget or capacity, tested next by raising
maxIterations alone) or any new false accept.

### Frozen Hypothesis 17 — prompt factorization validates controls

Stage 8's arm prompt differed globally, so control cells (housing)
shifted without any mechanism applying (codex verbatim share 0/12 →
15/27). H17: holding the base composition prompt IDENTICAL across arms
and injecting mechanism text only on cells where the mechanism applies
makes control cells statistically indistinguishable across arms.
Prediction: housing verdict flips across arms ≤ checker-stochasticity
baseline (measured by the Stage 5 same-cell repeat variance); becomes a
standing design rule for every future arm if confirmed. Falsified by
persistent control-cell drift under identical prompts (which would
implicate the mechanism text itself leaking into non-case behavior).

### Typed claim roles — schema-level premise distinction (registered 2026-07-30, per Eli)

Stage 7 found the lint cannot distinguish a premise-correction claim
from overreach: both are novel-content by construction. Eli's
proposal — distinguish the supplied premise SCHEMA-side, not
statistically — dissolves the false-positive class instead of
calibrating around it. Design: the submission schema's claims gain an
explicit `kind` (quotation | conclusion | premise_correction),
making the Stage 6 contract's implicit claim types first-class. A
premise_correction claim must carry `premise_text` that is a VERBATIM
substring of the premise's source — the user's question, or, in
multi-turn settings, the assistant's own prior answer (source named
in the field) — plus evidence_ids whose spans ground the correction.
Both requirements are deterministically checkable with typed
rejections, exactly like the quotation tier: the premise anchor is
substring-verifiable, the grounding is span-verifiable. The lint then
keys its thresholds on kind — novel-content witnesses skip
premise_correction claims because a stronger deterministic contract
replaced them, not because they were inconvenient. Renderer gains
honest framing from the schema ("the question assumes X; the source
says Y") built from receipts, never parsed from prose. Joins the
Stage 8b factored design as a schema change shared by ALL arms (it is
contract infrastructure, not an arm contrast); its per-kind lint
keying is a registered C4 ensemble witness.

### Candidate Hypothesis 18 — transparent witnesses beat blackbox grading
(design frozen after Stage 7's verdict; direction registered now, per
Eli's directive 2026-07-30)

Today the deterministic machinery mostly grades the model from outside:
compose → gate → typed rejection or checker verdict. H18: exposing the
witnesses TO the composer concisely — an observability panel in
context, not just post-hoc bounces — recruits in-context learning and
produces better first submissions, not just better-filtered ones.
Concretely: alongside the evidence, the composer sees a compact
per-source panel (attested-characterization count and top candidates,
citer count / court level / profile tier, alienness reading of its own
draft claim via the lint's feature values, temporal ordering facts) —
the same receipts we already compute, surfaced before and during
composition rather than only as rejection text. The lint_gated arm's
bounce message (feature names + values) is the minimal version and
Stage 7 measures it; H18 is the full version. Predictions (to be
frozen with the design): first-submission acceptance rises vs
lint_gated; checker calls fall further; no new false accepts (the gate
stays — transparency ADDS to enforcement, never replaces it).
Falsified by: panel text leaking into claims (parroting the panel
instead of the source — detectable, the panel is not quotable
evidence), or no first-submission improvement over the bounce-only
form. Token cost per cell recorded; the panel must stay concise
enough that flat-rate lanes tolerate the matrix.

Design: one factored run on the held-constant 41-item matrix — base
prompt constant everywhere (H17), fallback rung present in all
case-cell arms (H16), required slot as the single arm contrast (H15) —
against tiered_check re-run under the same factored base prompt.
Secondary measured (not gated): rich-cell token-F1, which Stage 8
showed sagging under feed-forward (0.57 → 0.38 codex), attributable to
candidate volume/placement; recorded per-cell to inform, not to tune
mid-run. Runs only after Stage 7's lanes drain; Charlotin probes queue
after Stage 8b to grow the positive class per protocol C4.

### Model-diversity axis (added 2026-07-30, per Eli's directive)

Every conclusion since Stage 6 rests on two composer models and ONE
checker family (Claude). Two diversity extensions, both flat-rate:
- Composer tier/vintage/family spread (AMENDED 2026-07-30 per Eli):
  the codex lane serves multiple slugs concurrently — catalog per
  `codex debug models`: gpt-5.6-sol/-terra/-luna, gpt-5.5, gpt-5.4,
  gpt-5.4-mini — and the claude-p lane serves any Claude model.
  Stage 8b roster: keep gpt-5.6-sol + claude-sonnet-4-6 as the
  held-constant anchors, add gpt-5.4-mini and claude-haiku-4-5 as the
  small-tier points (cross-family tier contrast). Prediction to
  freeze with the run: capability trades COVERAGE, never SOUNDNESS —
  small-tier typed refusals and non-submissions may rise; false
  accepts must not. Ollama/qwen3.5 arms are DEFERRED (Eli,
  2026-07-30): the models' context window is too small to be
  informative until the planned hyper-compaction layer for Beaver RAG
  exists; revisit then.
- Checker-family crossing: on a Stage 8b subset, codex as checker vs
  the pinned Claude checker over identical composed answers, measuring
  verdict agreement. Controls for single-checker-family bias in every
  stage verdict to date; disagreement cells get audited by hand.

### H16′ upgrade — diff-carrying rejections (registered 2026-07-30, pre-run, per Eli)

Eli's directive mid-implementation: ALR-Quote-Verifier already holds
text-diff machinery for quote verification — examine it. Its
`_quote_match_score` / `_build_corrected_citation` align a claimed
quote against the source token-by-token (SequenceMatcher with
legal-editorial equivalences) and emit a corrected quote. Ported in
approach (never runtime-imported, per the reference-implementation
doctrine) as `backend/src/lib/chat/quoteRepair.ts`, narrowed to what
Beaver's strict tier accepts: since the tier requires a CONTIGUOUS
substring, the repair offered is the cited span's own best-matching
contiguous token window (longest common run, >= 6 tokens, >= 25 chars,
score >= 0.5) — verbatim by construction, so requoting it always
clears. Wired into all three quote-family rejections (typed-quotation
failure, stands-for, conclusion-allowance overflow). This SHARPENS
H16′, registered before any Stage 8b cell ran: the bounce no longer
restates the rules — it hands the repair. Sharpened prediction:
quotation bounces converge in <= 1 revision; non-submission collapses
(claude-p 9/9 -> <= 1/9 stands). New falsifier: excerpt-parroting —
models accepting suggested excerpts that do not serve the question
(measured as F1/answerability degradation on repaired cells vs
un-bounced cells). Thin overlap yields NO suggestion by design: a
lookalike quote must never be manufactured for a claim the span does
not actually contain. Unit round-trip proven: a bounced near-miss's
suggested excerpt clears `deterministicClaimSupport` when resubmitted
(`quoteRepair.test.ts`).

### Implementation and launch (2026-07-30)

Implementation commit `0c2e4adf` (13 new unit vectors, 40/40 pass):
typed claim roles enforced at submission (premise_text verbatim >= 10
normalized chars in the named source; verified corrections exempt from
the conclusion allowance and the lint bounce but NEVER from the
stands-for bar — premise typing cannot launder a characterization);
H15 `required_slot` arm (slot filled only by attested-verbatim quote
against the citator receipt's own span, or the exact refusal sentence
naming the citation); H17 factored prompts (shared base + roles
modules; quote_contract on quote-family arms; attested/slot modules
injected ONLY on case-law cells, so attested arms and quote_first are
prompt-identical on legislation/housing cells; per-cell `prompt_modules`
in runner receipts, schema v2); bounce archive (pre-bounce claims +
rejection text, receipt event schema v6).

Smoke (2 cells, receipts in scratch): codex:gpt-5.4-mini ran the full
slot contract and failed only at the holistic checker verdict on its
conclusion claim (normal contract behavior); claude-p:claude-haiku-4-5
submitted, drew a diff-carrying bounce ("28 of 28 words match" plus the
exact excerpt), then outran the 90s default timeout mid-revision —
cell timeout raised to 180s for the run on that evidence.

Run launched 2026-07-30: 656 cells = 4 models (anchors
codex:gpt-5.6-sol + claude-p:claude-sonnet-4-6; small tier
codex:gpt-5.4-mini + claude-p:claude-haiku-4-5) × 4 arms (tiered_check,
quote_first, attested_framing, required_slot) × the held-constant
41-item matrix; same-model checker (crossing subset follows analysis);
effort low; pool 8/2; receipts
`%LOCALAPPDATA%\OpenLegalData\experiments\legal-grounding\2026-07-30\stage8b-h15h16h17.jsonl`
(sha256 recorded at analysis). lint_gated is not in the run roster:
the typed-role lint exemption is unit-tested contract infrastructure,
and Stage 7 already measured the lint arm's economics.

### Stage 8b run history (2026-07-30)

The run survived four relaunches and a machine reboot on resume
support added mid-run (runner `--resume 1`, commit `c81627a4`): a
non-error row marks its cell (model|arm|checker|case_id) done; errored
cells re-run; the receipts file may hold both rows. Analysis dedupes
keeping the LAST row per cell; first-attempt error rates are computed
over ALL rows including superseded ones. Concurrency was tuned for
machine load (pool 8/2 → 12/4 → 16/16 → 6/6 → 3/3, worker priority
BelowNormal then Idle). Both codex lanes and the sonnet lane
completed; the haiku lane was STOPPED early by Eli's directive — its
attrition profile (below) was judged the result, not worth the
remaining wall-clock. Final receipts: 859 rows, 601/656 unique cells
attempted, 549 clean (sol 164/164, sonnet 161/164, mini 164/164,
haiku 60/164; haiku's `required_slot` arm never started).

### Mid-run observation — the small-tier cost surfaces as latency and
transport attrition, not unsoundness (registered mid-run per Eli)

Haiku, nominally the fastest model in the roster, was the slowest
lane by an order of magnitude: median clean-cell latency 91.6s (p90
153s) vs 8.1–16.2s for the other three, with median output tokens
3312 per cell vs 335–420 — roughly 8× the emission for the same
contract. Its organic failure mode is protocol-following, not
verdicts: over all rows, 46 replies that were neither FINAL nor
TOOL_CALLS, 9 malformed-JSON replies, concentrated on 38 distinct
cells (first-attempt error rates 45–48% per arm). A further 37
"Stream aborted" rows are partly artifacts of the operator kills and
the machine reboot (24 cells are abort-only and ambiguous; they are
excluded from the protocol-failure count). On the 60 cells haiku DID
complete, soundness held: 25/25 passed on tiered_check, and its 8
quotation bounces all converged in exactly one revision. The
contract's iteration-plus-protocol burden lands on a small-tier
model as latency and attrition BEFORE it lands as unsound output —
consistent with the frozen small-tier prediction. Haiku's per-arm F1
is NOT comparable to full lanes (survivor bias: sonnet's F1 on the
haiku-completed subsets shifts ±0.09 in both directions vs its full
matrix).

### Stage 8b results by frozen prediction (analysis 2026-07-30)

Receipts `stage8b-h15h16h17.jsonl`, sha256
`f7c3861b9669d7963512ced1fb623928ea3fd221008b088d289589f015592067`,
859 rows. All numbers below are over deduped clean cells; checker is
same-model; labels remain checker-derived, not gold.

**H15 (required slot) — core confirmed, but two registered falsifiers
triggered.** The slot is syntactically airtight: on case-law cells,
every SUBMITTED answer either quoted an attested characterization
verbatim or used the exact typed refusal sentence —
submitted-but-neither = 0 for all models. Uptake is contract-driven
as hypothesized: attested-quote clearances went from Stage 8's zero
(optional candidates) to 5/18 case cells (sol), 3/18 (mini), 1/15
(sonnet) under the required slot, and the degenerate-slot-filling
falsifier did NOT fire (no irrelevant candidate quoted to satisfy the
slot). But the slot costs coverage on rich cells, which was a
registered falsifier: no-submission on case cells with candidates
available ran 7/18 (sol), 8/15 (sonnet), 12/18 (mini), and every
typed refusal (6 sol, 6 sonnet, 3 mini) occurred DESPITE candidates
being offered — the refusal sentence acted as an escape hatch, the
inverse failure of the one the falsifier anticipated. Arm pass rates
(49–61%) also sat below tiered_check on the same cells (76–85%), the
third registered falsifier. Verdict: contract shape determines
affordance uptake (H15's mechanism stands), but THIS slot design
trades too much coverage — models bail rather than choose among
candidates. The candidate-selection burden, not the quoting burden,
is the binding constraint; any Stage 9 slot design must make
selection cheap (fewer, better-ranked candidates) before requiring
it.

**H16′ (diff-carrying bounces) — supported; falsifier clean.** The
headline collapse is fixed: sonnet non-submission on quote_first fell
from Stage 8's 9/9 to 1/41. Of 247 verbatim-type bounce errors, 101
carried a repair suggestion (thin-overlap cells get none by design);
19 final submissions adopted the suggested excerpt and all 19 cleared
the deterministic tier. Excerpt-parroting did not materialize: F1 on
bounce-heavy arms did not degrade (haiku's attested_framing, all
repaired cells, is the matrix's highest F1 at 0.402). Convergence
after one quotation bounce: sonnet 35/52 (41/52 eventually), haiku
8/8, mini 15/31, sol 7/16 — the "≤1 revision" prediction holds as
the majority mode but not universally; the never-converged residue
concentrates in required_slot cells where the failure is H15's
candidate-selection bail, not quote repair. Claude-family models use
the repair machinery far more than codex (52 sonnet bounced cells vs
16 sol), consistent with codex first-drafting verbatim quotes more
often.

**H17 (prompt factorization) — confirmed; adopted as standing design
rule.** On the 23 legislation/housing cells where attested arms are
prompt-identical to quote_first, `prompt_modules` receipts confirm
identity 23/23 per model, and outcome flips across those arm pairs
were 0/23 (sol), 1/23 (sonnet), 3/23 (mini), 0/2 (haiku) — a
measured checker-stochasticity floor of 0–13% that future arm
contrasts must clear before claiming an effect. Stage 8's
control-cell drift is thereby attributed to global prompt wording,
not mechanism leakage.

**Typed claim roles — working as specified.** premise_correction was
used spontaneously by every model (18 sol / 23 sonnet / 16 mini / 3
haiku claims) and every single one carried a verified premise anchor
(premise_support true 60/60). The schema-side dissolution of Stage
7's premise-correction false-positive class is functioning in vivo,
not just in unit vectors.

**Small-tier prediction (capability trades coverage, never
soundness) — supported on both points.** mini's soundness matches
the anchors (submitted-but-neither 0, pass rates on par with sol,
zero transport errors); its cost shows exactly where predicted, as
coverage: 12/18 case-cell non-submissions on required_slot vs sol's
7/18. Haiku's version of the same trade is the transport-attrition
observation above. No false accept was observed in any small-tier
lane (audit caveat: checker-derived labels).

## Stage 9 — rank-policy ablation and cheap selection (pre-registered
2026-07-30, frozen before implementation)

Stage 8b localized the required slot's failure to CANDIDATE SELECTION
cost, not quoting ability, and exposed that the incumbent candidate
ordering (court level, citer count, recency; commentary implicitly
last via unmapped level) is an unmeasured formalist assumption. Per
Eli's directive (2026-07-30): "the declarative principle of judicial
lawmaking is a legal fiction" — journal commentary is often the more
principled statement of what a case stands for; whether authority
hierarchy helps the RAG contract must be tested, not assumed.

### Frozen Hypothesis 19 — candidate ordering policy is a live variable

Three deterministic rank policies over `standsForProfile` candidates,
identical machinery otherwise:
- A `authority` (incumbent, control): citing-court level desc, citer
  occurrences desc, recency desc; commentary carries no level and so
  sorts last.
- B `banded_recency` (Eli's proposal): band = citing-court level for
  case candidates; commentary joins the HIGHEST band present in the
  profile (apex when apex citers exist, otherwise the top available
  level); newest-first within every band.
- C `flat_recency`: newest first regardless of source kind; ties by
  occurrences then level.
Registered as EXPLORATORY on direction — no policy is predicted to
win; the gate is that any claimed policy effect must exceed the
measured Stage 8b checker-stochasticity floor (0–13% outcome flips on
prompt-identical cells). Outcome variables per policy: slot uptake,
no-submission rate, refusal-despite-candidates, quoted-candidate RANK
(new receipt), F1 on case cells. Machinery falsifier: any widened-tier
false pass under any policy, or a policy changing the candidate SET
rather than only its order (audited from receipts).

### Frozen Hypothesis 20 — cheap selection restores slot coverage

Stage 8b offered up to 8 candidates late; models bailed (no-submission
7–12/18 case cells) or used the refusal escape hatch with candidates
present (15/15 refusals). H20: selection cost, not the slot itself, is
the binding constraint. Two changes, constant across policies: the
offer is capped at the TOP 3 ranked candidates, and a thin-profile
pre-declaration module states up front, per cited case, how many
attested characterizations are supplied (and the newest's year) or
that none are. Predictions vs Stage 8b required_slot (cap 8, policy
A): case-cell no-submission drops toward the quote_first baseline
(<= 3/18 per model); refusal-despite-candidates -> ~0; none-tier
honest refusals persist unchanged; zero new false passes. Falsifiers:
no-submission persisting at cap 3 (implicates the slot concept, not
selection cost — retire the required slot); degenerate top-1 quoting
of irrelevant candidates (hand-audited sample per model).

### H10-minimal — temporal-order hard flag (rides all arms)

Deterministic typed rejection when a single claim asserts an active
follow/apply/adopt/affirm/distinguish/overrule relation between two
resolved citations whose receipt dates invert the assertion (the
"following" decision predates the "followed" one). Dates come only
from evidence receipts already in state; no new lookups; conservative
active-voice pattern requiring both citations present in the claim
text. Prediction: zero false flags on the matrix (any flag that fires
is a caught fabrication; count reported). Falsifier: any false flag
on audit — the pattern narrows before shipping.

### H13-advisory — alienness named in bounce text (advisory, never a gate)

When a submission already bounces for a typed contract violation, the
rejection text additionally names the conclusion claim's corpus-alien
phrases (maximal contiguous runs of trigrams unattested in the H13
reference index) with the instruction to answer in the source's
words. The advisory NEVER causes a bounce and no threshold gates
anything — nothing to overfit; the deterministic tier and checker are
unchanged. Per-conclusion-claim alienness spectra are also recorded
in run receipts (receipt-only witness, grows the C4 matrix).
Predictions: no coverage or F1 regression (advisory-only);
exploratory: post-bounce revisions shift toward lower unattested
share. Falsifier: corpus-phrase parroting that clears the checker
with degraded F1 on advised cells (the tier cannot be cleared by
parroting — the panel is not quotable evidence).

AMENDED PRE-ANALYSIS (2026-07-30, per Eli, ~200/708 cells in): the
live run carries ONLY policy C (flat_recency, "newest = better");
policies A and B are postponed, not retired — their 22 completed
cells (11 authority, 11 banded, all gpt-5.6-sol) stay in the receipts
file and the H19 three-way comparison runs when those lanes are
resumed. Stage 9's live questions are therefore H20 (cheap selection
under flat recency), the temporal flag, and the alienness advisory;
any flat-recency-vs-Stage-8b contrast confounds policy with the H20
changes and must be labeled accordingly.

### Design (factored per the H17 standing rule)

Roster: codex:gpt-5.6-sol, claude-p:claude-sonnet-4-6,
codex:gpt-5.4-mini. Haiku is DROPPED from composition rosters until a
protocol-tolerant wrapper exists (Stage 8b transport finding); its
lane would measure transport attrition, not grounding. Same-model
checker; the checker-family crossing subset follows analysis.
Arms: tiered_check and quote_first (policy-independent anchors, run
once), attested_framing and required_slot (policy-varying). Rank
policy varies ONLY case cells of attested arms (A/B/C variants per
cell); non-case cells run once under policy A — the policy module is
a no-op there, and prompt_modules receipts prove prompt identity as
in Stage 8b. All Stage 9 modules (predeclare, temporal flag,
alienness advisory) ride every arm identically, so the policy
contrast is the only inter-arm difference on case cells. Held-constant
41-item matrix; effort low; timeout 180s; receipts under the standard
experiments directory with sha256 recorded at analysis; checker labels
never promoted to gold.

### Stage 9 results (run + analysis 2026-07-30; flat_recency lane only)

Receipts `stage9-h19h20.jsonl`, sha256
`7aa340c88f1d625d9765c9840d632aa451cea0cba625b27ed0b5d8bfe3bb675a`,
515 rows, 509 unique clean cells (6 errors, all sonnet transport — 4
of them on required_slot). Roster sol/sonnet/mini; the 22 postponed
authority/banded cells remain in-file unanalyzed per the amendment.
All required_slot/attested numbers below CONFOUND flat_recency with
the H20 changes by design (single live policy).

**H20 (cheap selection) — the escape hatch is dead; the bail is
half-fixed.** Refusal-despite-candidates went 15/15 (Stage 8b, all
three models) to **0/0/0**: with a top-3 offer and the availability
pre-declaration, every typed refusal in the run is honest (the
citation genuinely had no candidates). Case-cell no-submission on
required_slot: sol 7/18 → **2/18** (prediction ≤3 met), mini 12/18 →
8/18 (improved, missed the target), sonnet 8/15 → 7/14 (unmoved —
and its 4 transport errors sit on this arm too, so the claude lane's
binding constraint on the slot looks like transport/iteration budget,
not selection). Attested-quote slot fills rose modestly (5/1/3 →
5/3/5). Verdict: selection cost was a REAL constraint (the refusal
result) but not the only one; the residual no-submission on the
small-tier and claude lanes needs a different lever (H18 panel, or
iteration budget).

**Quoted-rank receipt — models genuinely select.** Of attested quotes
with a recorded rank, positions 1/2/3 were all used by every model
(sol 2/2/1, sonnet 1/1/1, mini 3/1/1). The degenerate-top-1 falsifier
did not fire: under flat-recency ordering models pick by content, not
list position — which also means ordering policy has room to matter
(H19 remains a live question for the postponed lanes).

**Temporal flag — zero fires.** Registered prediction (zero false
flags) held; the matrix also produced no true inversions to catch.
The flag is now standing contract infrastructure awaiting adversarial
probes (Charlotin lane).

**Alienness advisory — live at scale, no measurable cost.** 149
bounces on 54 cells carried the advisory; conclusion-claim alienness
spectra recorded on 424/509 cells (C4 matrix growth). Pass rates and
F1 vs Stage 8b are within the measured noise floor on every model×arm
(largest delta: mini quote_first 33→28, 12% — at the floor's edge,
flagged for the C4 pass; every other delta ≤3 cells, F1 deltas
≤0.04). No parroting-with-degraded-F1 signature appears on advised
cells.

**Transport note (infrastructure, measured):** the claude-p lane
gained opt-in persistent sessions (`MIKE_CLAUDE_P_PERSIST=1`,
commit `e640b740`) — one stream-json process per conversation,
follow-up turns send only tool_results, full-replay fallback on any
failure. Live A/B (sonnet, 2-tool-call loop): 14.5s → 6.0s with
prompt-cache reads engaged. OFF for all Stage 9 receipts above; a
future stage may enable it, recorded per-run.

## Stage 10 — transparent witness panel under persistent transport
(pre-registered 2026-07-30, before implementation)

Motivation: Stage 9 killed the refusal escape hatch but left a
residual case-cell no-submission (mini 8/18, sonnet 7/14) that the
verdict attributed to levers other than selection cost — the H18
panel or the claude lane's transport/iteration budget. Stage 10 tests
both at once, factored so they don't confound each other.

Design: two arms on the held-constant matrix, roster sol/sonnet/mini,
same-family checker, flat_recency, effort low: (a) `required_slot`
exactly as Stage 9 shipped it (the H20 configuration), and (b)
`witness_panel` = required_slot plus ONE added prompt module, injected
on case cells only (H17 factoring — non-case cells are byte-identical
across the two arms). Both arms run with `MIKE_CLAUDE_P_PERSIST=1` —
first adoption of the persistent claude-p transport, recorded here.
The within-run arm contrast is therefore transport-clean, and the
Stage 9 → Stage 10 `required_slot` delta separately measures the
transport fix on the claude lane.

Panel contents (facts the machinery already computes, surfaced BEFORE
composition instead of only inside rejection text): per cited case —
profile tier, distinct citing cases in the local graph, and each
supplied candidate's rank, date, citing court or journal, and source
kind; followed by a one-sentence statement of the deterministic
checks the submission will face and that a compliant first submission
is accepted without bounces. The panel is context, NOT registered
evidence: quoting it cannot clear the verbatim tier by construction.

### Frozen Hypothesis 18 (full form) — predictions

- P1 (primary): first-submission acceptance on case cells (accepted
  with zero typed rejections) is higher on witness_panel than
  required_slot within-run for at least two of three models, and
  total bounce mass per submitted case cell falls.
- P2: case-cell no-submission on witness_panel ≤ required_slot per
  model within-run; mini (Stage 9 baseline 8/18) reaches ≤5 of its
  case-cell denominator if the panel is the operative lever.
- P3 (parroting falsifier): an ACCEPTED claim whose text appears in
  the panel but not in registered evidence is impossible by
  construction; any such acceptance falsifies the verbatim tier and
  halts the program pending audit. Attempted parroting (verbatim-tier
  rejections whose claim text matches panel lines) is counted;
  if it exceeds 20% of case-cell bounce mass the panel design is
  declared a distraction and restyled before any further use.
- P4 (H17 control): non-case cells statistically identical across the
  two arms within the 0–13% checker noise floor.
- P5 (transport, secondary): sonnet transport-error cells 6 → ≤1 and
  claude-lane median latency falls vs Stage 9 (reported).
- Cost: the panel's input-token delta vs required_slot on case cells
  is reported per model; flat-rate lanes must tolerate the matrix.

Falsified by: P1 failing (no first-submission improvement in either
acceptance or bounce-mass form), parroting past threshold, any new
false accept, or control-cell drift beyond the floor. Denominators
reported exactly over completed cells, per the Stage 9 correction.

### Stage 10 results (run 2026-07-30, 246 cells, 234 clean; smoke 12/12)

Both arms ran under `MIKE_CLAUDE_P_PERSIST=1` as registered. Case-cell
metrics over clean cells (n varies with transport errors; exact
denominators shown):

| model | arm | n | pass | no-sub | first-sub accept | bounces | median lat | mean input tok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sol | required_slot | 18 | 6 | 2 | 5 | 18 | 20.8s | 4,733 |
| sol | witness_panel | 18 | 6 | 1 | 5 | 16 | 20.1s | 4,822 |
| sonnet | required_slot | 15 | 6 | 6 | 2 | 29 | 34.7s | n/r |
| sonnet | witness_panel | 12 | 5 | 4 | 1 | 20 | 31.5s | n/r |
| mini | required_slot | 18 | 2 | 8 | 2 | 32 | 22.0s | 5,712 |
| mini | witness_panel | 18 | 1 | 7 | 1 | 31 | 24.0s | 6,079 |

- **P1 FALSIFIED (primary).** First-submission acceptance rose for no
  model (sol 5→5, sonnet 2/15→1/12, mini 2→1). Per-cell bounce mass
  fell slightly everywhere (sol 1.00→0.89, sonnet 1.93→1.67, mini
  1.78→1.72), but the acceptance clause fails, and the falsifier
  clause names P1. Verdict: telling the model the checks it faces
  does not make first submissions compliant — the residual is not an
  information asymmetry.
- **P2 partial.** No-sub witness_panel ≤ required_slot for all three
  models (2→1, 6/15→4/12, 8→7), but mini lands at 7, missing the ≤5
  bar — the panel is NOT the operative lever for mini's residual
  no-submission. Remaining suspects from the Stage 9 attribution:
  composition capacity under the slot contract, not missing context.
- **P3 held perfectly.** Zero accepted panel-parroting claims (the
  by-construction guarantee stands; no program halt) and zero
  attempted parroting in 67 case-cell bounces across the three
  witness_panel lanes (0% < 20% threshold; no restyle needed).
- **P4 held.** Controls: sol 12/23 vs 12/23 (identical), sonnet 18/22
  vs 18/21 (Δ3.9pp), mini 19/23 vs 17/23 (Δ8.7pp) — all within the
  0–13% H17 noise floor.
- **P5 split; error clause falsified.** Claude-lane median latency
  fell 29.5s → 20.2s (required_slot, vs Stage 9), but transport
  errors did not: required_slot 4→4, and witness_panel added 8 more.
  The errors are two distinct modes: (a) unparseable-JSON replies
  recurring on the SAME three case cells in both arms
  (pss-case-0014, pss-case-0055, adv-pss-0045) — content-shaped, not
  spawn-shaped, so persistence cannot fix it; (b) six `Stream
  aborted` cells at exactly the 90s cap, clustered late in the run
  with late sonnet completions creeping to 50–84s — the persistent
  session appears to saturate under sustained load. Persistence is a
  latency lever, not a reliability lever.
- Cost: the panel costs +89 (sol) / +367 (mini) mean input tokens per
  case cell — cheap. The persist lane under-reports input tokens
  (mean ≈9/cell, a session-delta artifact), so claude-lane cost is
  not reportable this run (instrumentation gap recorded).
- Amendment to Stage 9's "escape hatch dead": that zero was
  behavioral, not gate-enforced — the slot contract accepts the
  unavailability sentence unconditionally. Stage 10 shows a low-rate
  recurrence: 2 of 246 cells asserted "No attested characterization
  of X is available" for a citation WITH candidates (sonnet
  required_slot pss-case-0004, candidates=1; mini witness_panel
  adv-pss-0015, candidates=3). Both cells failed the checker anyway
  (no false accept). Hardening candidate for a future stage:
  typed-reject the unavailability sentence when the citation's
  attested-candidate count is nonzero.

H18 verdict: falsified as the lever for residual no-submission. The
panel is safe (zero parroting, controls clean, trivial cost) but buys
nothing the slot contract doesn't already extract. The residual
no-sub on mini and the claude lane's content-shaped transport errors
are separate problems, and neither is information asymmetry.

## Roster amendment (Eli directive, 2026-07-30)

"Stop testing models below the luna tier; luna medium as our
baseline." Against the live codex catalog (priority order: gpt-5.6-sol
> gpt-5.6-terra > gpt-5.6-luna > gpt-5.5 > gpt-5.4 > gpt-5.4-mini >
gpt-5.3-codex-spark): **gpt-5.4-mini is retired** from composition
rosters (its Stage 8b–10 lanes stay in the record as measured);
**codex:gpt-5.6-luna at effort medium is the baseline** going
forward; sol (above the luna tier) is retained where a frontier-lane
contrast is wanted. Interpretation note recorded: claude-sonnet-4-6
is cross-family and has no defined position in the codex tier order;
it is retained as the claude-family lane pending direction, since
family diversity is load-bearing for the harness-vs-model question.

## H19 three-way on the banked lanes (zero-cost analysis, 2026-07-30)

The 22 postponed cells (sol, attested_framing, 11 case cells x
authority/banded_recency, effort low) compare directly against the
same 11 cells' flat_recency rows from the Stage 9 live run —
same model, arm, effort, checker. Result: **no policy effect
detectable.** pass 11/10/11, no-sub 0/0/0, bounces 1/0/0, attested
fills 6/5/5 (authority/banded/flat). Every difference is one cell
(9%), inside the 0–13% checker noise floor, per the H19 gate.
Caveats: sol only, and attested_framing is the arm where candidate
selection binds least (no required slot) — H19 stays open for the
slot contract, which Stage 11 carries on the new baseline.

## Stage 11 — luna-medium baseline + H19 under the slot contract
(pre-registered 2026-07-30, before the run)

Design: codex:gpt-5.6-luna, effort medium (the new baseline — note
this changes model AND effort vs prior stages; cross-stage deltas are
labeled baseline shifts, not controlled contrasts). Held-constant
41-item matrix, arm `required_slot` (the shipped H20 configuration),
same-model checker, timeout 180s. Rank policies
authority/banded_recency/flat_recency vary the 18 case cells (54
policy cells); the 23 non-case cells run once (policy is a no-op
there). 77 cells total. The within-run policy contrast is clean:
one model, one effort, one transport.

Frozen predictions:
- P1 (H19 under the slot): if candidate ordering matters where the
  slot binds, at least one outcome (slot uptake, no-sub,
  refusal-despite-candidates, pass) separates policies beyond the
  13% floor (>2 of 18 cells). Exploratory on direction per the H19
  registration — no policy is predicted to win.
- P2 (baseline): luna-medium case-cell no-sub <= sol-low's 2/18;
  zero widened-tier false passes; refusal-despite-candidates counted
  under the Stage 10 amendment (behavioral recurrence expected rare,
  not gate-blocked).
- P3 (cost): latency and token deltas vs sol-low reported; effort
  medium must tolerate the flat-rate lane.
Falsified by: any widened-tier false pass; a policy changing the
candidate SET rather than only order (audited from receipts).

## Stage 12 — Claude 5 family on the claude lane
(pre-registered 2026-07-30, before the run; Eli directive: "try some
newer sonnet models and then also opus 5 on some stuff")

Both models verified reachable over the flat-rate `claude -p`
subscription route before registration. Design, factored to keep the
model upgrade the ONLY change vs the Stage 10 sonnet-4-6
required_slot lane (same arm, flat_recency, effort low, same-model
checker, `MIKE_CLAUDE_P_PERSIST=1`):
- `claude-p:claude-sonnet-5`: full held-constant 41-item matrix (41
  cells) — the direct sonnet-4-6 → sonnet-5 upgrade contrast.
- `claude-p:claude-opus-5`: the 18 case cells only (the subset where
  the claude lane bails and errors) — the capability-ceiling read.
One labeled transport change: timeout raised 90s → 180s, because
Stage 10's `Stream aborted` errors sat exactly on the 90s cap;
error-cell comparisons vs Stage 10 must note this.

What Stage 12 discriminates: the program's standing finding is that
the HARNESS, not the model family, carries grounding decisions; but
Stage 10's H18 falsification re-attributed the residual case-cell
no-submission to composition capacity. If harness-bound, sonnet-5 ≈
sonnet-4-6 on pass/no-sub within the 0–13% floor and opus-5 adds
little; if capacity-bound, the newer/larger models move the residual
that the witness panel could not.

Frozen predictions:
- P1 (discriminating): reported as the capacity-vs-harness read
  above; exploratory on direction, gated on the 13% floor.
- P2 (transport): Stage 10's unparseable-JSON errors were
  content-shaped; prediction: sonnet-5 transport-error cells ≤
  sonnet-4-6's 4 on required_slot, and zero 90s-cap aborts under the
  180s timeout (labeled fix, reported separately).
- P3: zero verbatim-tier false passes (standing).
- Cost: latency and usage per lane reported; the subscription must
  tolerate the opus subset.
Falsified by: any false pass; transport attrition >20% of either
lane's cells (would mean the lane measures transport, not grounding,
per the Stage 8b haiku precedent).

### Stage 12 result: CUT by Eli mid-run; transport-falsified on what landed

Eli cut the run after the sonnet-5 lane completed (41/41 cells) and
the opus-5 lane had 10 rows. Every error on both lanes is the same
content-shaped `unparseable reply after retries` JSON failure — none
are kill artifacts. Attrition: sonnet-5 **8/41 (20%)**, opus-5 **6/10
(60%)** — both hit the registered >20%-attrition falsifier, so per
the registration the lanes measure transport, not grounding, and no
grounding conclusion is drawn. The Claude 5 family breaks the
`claude -p` JSON reply protocol MORE than sonnet-4-6 (4/41 in Stage
10), killing P2's direction. Clean-cell glimpse, recorded but NOT
scored (small n, attrition-biased toward easy cells): sonnet-5 case
no-sub 4/15; opus-5 4 clean case cells, 3 passed, 0 no-sub, 0
transport-clean bails. Prerequisite recorded: the claude-p transport
needs a structured-output/JSON-repair hardening pass before any
Claude-5 lane is runnable; until then the claude-family lane stays
on sonnet-4-6. Receipts `stage12-claude5.jsonl` (partial), sha256
`951FAC9DBA05921520C2175DB77E55CD0F639FF3893789908AC9BF5C359B064E`.

### Stage 11 results (run 2026-07-30, 77 cells, 0 errors; smoke 2/2 clean)

Case cells (n=18 per policy), luna medium, required_slot:

| policy | pass | no-sub | first-sub accept | bounces | refusals (despite) | attested fills | quoted ranks | median lat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| authority | 4 | 3 | 4 | 24 | 10 (0) | 4 | 1,2,1,3,1 | 34.5s |
| banded_recency | 4 | 3 | 3 | 23 | 10 (0) | 4 | 1,2,1,3,1 | 30.6s |
| flat_recency | 3 | 7 | 3 | 29 | 6 (0) | 3 | 1,1,2,3,1 | 32.4s |

Non-case: 17/23 pass. Zero transport errors; zero
refusal-despite-candidates; ranks 1/2/3 all used under every policy.

- **P1 FIRES — first policy effect of the program.** Under the slot
  contract, flat_recency produces 7/18 no-submission vs 3/18 under
  authority and banded_recency — a 4-cell (22%) separation, beyond
  the 13% gate. authority and banded_recency are indistinguishable
  from each other (every difference ≤1 cell). Direction: newest-first
  ordering costs coverage where the slot binds; the banked-lane null
  (attested_framing, no slot) is consistent — the policy only matters
  when the model must actually use a candidate. Caveat: one model,
  one run, n=18; no-sub is model behavior, not checker noise, but a
  replication rides the next scheduled matrix run.
- **P2 FALSIFIED.** Luna-medium no-sub on the flat_recency lane is
  7/18 vs sol-low's 2/18 (and 3/18 on its best policy) — the new
  baseline bails MORE than sol despite higher effort. The baseline
  directive costs case-cell coverage; flagged for Eli. Zero
  widened-tier false passes (standing gate holds).
- P3 (cost): median case-cell latency ~31–35s at effort medium (vs
  ~15–21s sol/luna low lanes); 341k input / 94k output tokens across
  77 cells — tolerated by the flat-rate lane.
- Config recommendation recorded: with luna-medium as baseline, the
  candidate offer should default to authority or banded_recency
  ordering, NOT flat_recency (coverage cost beyond the floor);
  between authority and banded the data cannot separate — Eli's
  banded proposal survives at no measured cost vs the incumbent.

## Stage 13 — codex tier/effort ladder
(pre-registered 2026-07-30; Eli's corrected roster directive: "test
luna, terra, and sol. Let's try luna max, terra max, sol medium, and
then a small set for sol max")

Design: arm `required_slot`, rank policy **authority** held constant
(the Stage 11 recommendation; flat_recency is retired as default),
same-model checker, timeout 300s (max-effort headroom), all codex
lanes (transport-clean — the claude lane is parked pending the
Stage 12 hardening prerequisite):
- `codex:gpt-5.6-luna` effort **max** — full 41-item matrix;
- `codex:gpt-5.6-terra` effort **max** — full 41-item matrix (first
  terra lane of the program);
- `codex:gpt-5.6-sol` effort **medium** — full 41-item matrix;
- `codex:gpt-5.6-sol` effort **max** — the 18 case cells only (the
  small set, spent where the residual lives).
141 cells. With Stage 9's sol-low and Stage 11's luna-medium lanes,
this yields effort ladders luna medium→max and sol low→medium→max
(case cells) plus a fresh frontier-adjacent tier (terra).

Frozen predictions:
- P1 (capacity hypothesis, the live question after H18's
  falsification): if the residual case-cell no-submission is
  capacity-bound, it falls monotonically with effort within each
  model (sol low 2/18 → medium → max; luna medium 3/18 → max) and
  the strongest lane reaches ≤1/18. If it is contract-bound, effort
  does not move it beyond the 13% floor — which would say the bail
  is the contract's honest price, not a model limitation.
- P2: zero verbatim-tier false passes; refusal-despite-candidates
  counted (behavioral recurrence expected rare).
- P3 (cost): latency/tokens per lane reported; max-effort lanes must
  stay under the 300s timeout without saturating the flat-rate lane.
Falsified by: any false pass; transport attrition >20% on any lane.

### Stage 13 results (run 2026-07-30, 141 cells, attrition 1/141;
`stage13-ladder.jsonl` + `stage13-solmax.jsonl` — the runner resume
key omits effort, so the sol@max lane required its own file; analysis
splits lanes by the receipt `effort` field)

Case cells (18), required_slot / authority / same-model checker:

| lane | pass | no-sub | typed refusals | first-sub accept | median lat |
| --- | --- | --- | --- | --- | --- |
| sol @low (Stage 9 bank) | 6 | 7 | 6 | 5 | 38.2s |
| sol @medium | 6 | 3 | 10 | 5 | 27.1s |
| sol @max | 5 | 2 | 11 | 4 | 64.0s |
| luna @medium (Stage 11) | 4 | 3 | 10 | 4 | 34.5s |
| luna @max | 3 (of 17) | 4 | 8 | 3 | 115.8s |
| terra @max | 6 | 3 | 10 | 5 | 99.7s |

- **P1: split verdict, informative.** Sol behaves capacity-bound —
  no-sub falls monotonically with effort (7→3→2) and ends below the
  13% floor — but no lane reached ≤1/18, and luna is effort-saturated
  by medium (3→4 flat, within one cell). What effort buys is typed
  honesty, not coverage: as sol's no-sub falls, its typed refusal
  count rises in step (6→10→11) while pass stays flat (6→6→5). The
  residual is task-shaped, not model-shaped: EVERY no-sub cell in
  every medium+ lane is a CLERC opinion-continuation cell (CSLB case
  cells all clear), concentrated on a recurring pair
  (clerc:2176611-7107, clerc:698751-10630 in 3 of 5 strong lanes)
  but not perfectly cell-deterministic (luna@max bailed a different
  trio). Conclusion: the bail floor is the contract's honest price on
  continuation-composition tasks; raising effort or tier past
  sol@medium buys little.
- **P2 held.** Zero refusal-despite-candidates on all codex ladder
  lanes; no verbatim-tier false pass surfaced.
- **P3 (cost).** Max-effort lanes run 2–4× medium latency (sol 27→64s,
  luna 35→116s, terra 100s) with no pass gain anywhere. All under the
  300s timeout; attrition 1/141 (one luna@max content-shaped error).

Roster consequence: **sol@medium is the crowned lane** (best pass ×
lowest bail × cheapest latency; terra@max ties on outcomes at 3.7×
the latency). Luna@medium remains the cost baseline. Max effort is
retired for grounding runs — it converts bails to typed refusals at
sol but buys nothing terra/luna, and doubles-to-quadruples latency.

## Stage 12b — claude-p transport hardening (amendment to Stage 12,
2026-07-30, commit `b7584a05`)

The Stage 12 prerequisite is done. All 14 Stage 12 errors were one
shape: `TOOL_CALLS` JSON breaking mid-string ("Expected ',' or '}'
after property value" at position ~1000–2000) — unescaped double
quotes/newlines where the tool input embeds legal text that itself
contains quotation marks. Three layers shipped in
`src/lib/llm/claudeP.ts` (+12 unit vectors incl. the observed
shapes): the transport protocol now demands strict escaped JSON; the
parser tolerates code fences / preamble / same-line markers and falls
back to `jsonrepair` (soundness argument: the deterministic verbatim
gate re-verifies every quoted span against source text, so a repair
that mutated a quote fails typed — it cannot create a false pass);
retries feed the parse error back as a corrective turn instead of
resending an identical payload. Usage now accumulates on failed
parses too.

Probe (not a grounding stage): the exact 14 failed cells rerun,
required_slot / authority / effort low / same-model checker, 300s
timeout → `stage12b-transport-probe.jsonl`. **Attrition 14/14 → 0/14.**
The repair layer fired 14 times and absorbed every failure on first
attempt (no corrective round-trips needed). Outcomes are now
grounding-shaped: sonnet-5 5/8 passed + 3 typed no-sub; opus-5 5/6
passed + 1 checker rejection — opus-5 cleared five hard case cells,
consistent with the Stage 12 clean-cell glimpse. Claude-5 lanes are
unblocked; any future lane pre-registers as usual.

## Stage 14 — real-world bed: LegalBench-RAG-mini over the grounding
harness (pre-registered 2026-07-30, before any scored run; Eli:
"proceed by pitting our best hypothesis forward against a real-world
test")

Bed: LegalBench-RAG mini (vendored, manifest-pinned; 776 tests over
real contracts — CUAD/MAUD/ContractNLI/PrivacyQA — with HUMAN-annotated
gold char spans). Gold is text spans and our claims are verbatim text
spans, so scoring is fully deterministic (`charPrecisionRecall`,
upstream formulas, scoring_version legalbench-rag-mini-charspan-1) —
no stochastic checker in the score path. Prior product baseline
(2026-07-28, FTS5 bm25 + snippet window): overall char P 0.0077 /
R 0.0209 / doc recall 0.4987 at k=8.

Adapter `scripts/legalbench-rag-grounding.ts`: per test, product
retrieval (same searchLocalA2AJ configuration as the baseline) feeds
top-k snippets as evidence receipts; the required_slot contract
composes (contracts are non-case cells, so the citator machinery is
a structural no-op and the operative modules are base + roles +
quote_contract, held verbatim from the stage runner); final quotation
claims are located back to original char coordinates and scored
against gold. Each row also scores the raw top-k retrieval spans, so
harness-vs-baseline is paired per test. Outcomes are typed: answered
(≥1 located verbatim quote) / declined (honest quoteless
insufficiency statement) / rejected / abstained / error.

Smoke (4 tests, luna@medium, k=4, receipts in temp — not scored): 0
errors, 0 unlocated quotes, 3 declined + 1 abstained; retrieval fed
no gold-span chars on any of the four and the contract declined
rather than fabricate. Retrieval quality, not composition, is the
visible bottleneck — the registration below prices that in.

Pilot: 32 tests (first 8 per source, deterministic file order),
k=4, `codex:gpt-5.6-luna` @medium (declared baseline; the Stage 13
winner may add a lane), required_slot, 300s timeout →
`stage14-lbrag.jsonl`.

Frozen predictions:
- P1 (soundness, primary): zero unlocated quotes — every
  deterministic-verbatim quote locates in its retrieved document —
  and zero verbatim-tier false passes. Any unlocated quote is a
  soundness alarm and halts scoring pending audit.
- P2 (honesty under retrieval failure): answered cells concentrate
  where retrieval found the gold document; answered ∩ gold-doc-miss
  ≤ 1 cell of the 32.
- P3 (precision): over answered cells, grounded char precision ≥
  0.077 (≥10× the 0.0077 retrieval baseline).
- P4 (volume): grounded chars per answered cell ≤ half the baseline's
  retrieved chars/query (~800 → ≤400).
- Reported, not predicted: answer rate (expected LOW — the honest
  price of the contract under a weak retriever), per-source splits,
  latency, tokens.
Falsified by: any P1 violation; answered-rate 0/32 (bed uninformative
at this retrieval level — the next lever is retrieval, not
composition, and the run is recorded as such); error rate >20%.

### Stage 14 pilot results (run 2026-07-30, 32 tests, luna@medium,
k=4, 0 errors → `stage14-lbrag.jsonl`)

Outcomes: answered 2, declined 21, rejected 1, abstained 8. Every
privacy_qa cell abstained (retrieval doc recall 0 on that slice);
every cuad/maud cell where retrieval missed gold declined with a
typed insufficiency statement naming what the passage cannot
establish. The contract did not fabricate once on 30 retrieval-failed
cells — the real-world bed's version of the refusal-shaped-failure
result.

- **P1 (soundness): alarm fired once, audited, resolved — no false
  pass.** maud:002 carried one gate-accepted quote my locator could
  not place: the model wrapped a genuinely verbatim span in curly
  quotation marks, which the gate's normalizer tolerates but the
  exact `indexOf` locator did not. Offline re-location with a
  hardened locator (wrapping-glyph strip + whitespace/quote-tolerant
  regex, exact offsets; committed) places the quote at chars
  7441–7564 of the GOLD document. The verbatim tier was sound; the
  measurement tool was too strict. Post-audit the cell reclassifies
  declined → answered with a located zero-overlap quote
  (definitions boilerplate, P=0).
- **P2 held.** Answered ∩ gold-doc-miss = 0/32 (also post-audit:
  all three answered cells quote the gold document). The contract
  answers only where retrieval actually found the right document.
- **P3 held.** Answered-only grounded char precision 0.66 as-run
  (2 cells: 1.000 and 0.329), 0.44 post-audit (3 cells) — 57–86×
  the 0.0077 retrieval baseline, far above the ≥0.077 bar. Recall
  on answered cells 0.88 as-run (contractnli:004 quoted 99.8% of
  gold).
- **P4 missed in letter.** Grounded chars per answered cell ≈526
  mean (584/872/123), above the ≤400 prediction. The excess is
  gold-span coverage, not dumping — answered-cell recall 0.58–0.88
  means the quotes ARE the gold passage; the ≤400 bar was
  mis-calibrated against high recall. Recorded as a falsified
  volume prediction, not a system defect.
- Cost: 7.3 s/cell mean, ~1.8k effective input + ~0.3k output
  tokens/cell — the cheapest lane of the program.

Verdict: on real contracts with human gold, the system's precision
when it speaks is 1–2 orders above the retrieval baseline, it never
speaks from the wrong document, and its failure mode is a typed,
named insufficiency — but the product retriever caps the answer rate
at 3/32 on this bed. The next lever is retrieval (better doc
targeting; snippet windows that cover gold spans), not composition.
Follow-ups queued: retrieval-lever ablation (k, doc-name matching);
Stage 13 winner lane on the same 32 for a model contrast.

## Stage 15 — retrieval overhaul (pre-registered 2026-07-30 before the
scored confirm run; Eli: "let's fix this comprehensively")

Diagnosis (from code + Stage 14 failure pattern): the doc-level search
path had four compounding defects — first-12-token query truncation
that discarded the question, AND-conjunction that zeroed a document
for one absent token, whole-document bm25 with no passage unit, and a
snippet window anchored at the first token hit (the header).

Fix (`src/lib/passageRetrieval.ts`, commit `3997cf12`): boundary-aware
offset-preserving chunker; derived sidecar FTS5 passage index (source
db read-only); OR-semantics bm25 with doc name/citation columns on
every passage row (bm25 column weights = doc targeting); per-doc
diversity cap; verbatim-slice invariant (7 unit vectors); `rrfFuse`
standing by as the dense-lane fusion point (no local embedding
runtime installed; fastembed/ONNX is the no-API-spend vehicle if
lexical recall proves insufficient).

Offline lever selection (776 tests, deterministic, zero model calls):
every swept config dominates the baseline; monotone in chunk target,
overlap 120 > 0, nameWeight 16 ≥ 4 > 1. Winner **t1600/o120/w16**:
at k=4 char P 0.0303 / R 0.2865 / doc recall 0.9884 (~4.8k chars per
query); at k=8 R 0.2919 / doc recall 0.9948 for double the volume.
Baseline: P 0.0077 / R 0.0209 / doc recall 0.4987. Doc targeting is
effectively solved lexically; residual char-recall ceiling (~0.29) is
the paraphrase gap — the dense lane's job, only if needed.

Confirm run (the registered test that precision guarantees are
structural and survive coverage growth): same 32 tests as Stage 14,
`codex:gpt-5.6-sol` @medium (Stage 13 crowned lane), required_slot,
`--retriever passage` t1600/o120/w16, k=4 →
`stage15-lbrag-passage.jsonl`. Frozen predictions:
- P1 (invariants): zero unresolved unlocated quotes; answered ∩
  gold-doc-miss ≤ 1.
- P2 (coverage): answered rate ≥ 2× the Stage 14 pilot (≥6/32),
  driven by the 14× char-recall feed.
- P3 (precision survives): answered-only grounded char precision
  stays ≥ 0.077 (≥10× the original retrieval baseline).
- P4: residual retrieval misses still produce typed decline/
  abstention, never fabrication.
Falsified by: any P1 breach; answered-only precision < 0.077 (the
thesis clause — coverage bought by sacrificing precision); error rate
>20%.

### Stage 15 confirm results (run 2026-07-30, 32 tests, sol@medium,
passage t1600/o120/w16, k=4, 0 errors → `stage15-lbrag-passage.jsonl`)

Outcomes: answered 21, declined 11, rejected 0, abstained 0.

- **P1 held.** Unlocated quotes 0; answered ∩ gold-doc-miss 0; doc
  recall 1.00 on every slice.
- **P2 held decisively.** Answered 21/32 vs the pilot's 3/32 — 7×,
  far above the ≥6 bar. privacy_qa flipped 8/8 abstained → 8/8
  answered.
- **P3 held — the thesis clause.** Answered-only grounded char
  precision 0.4429 (57× the original 0.0077 baseline) across a 7×
  coverage expansion. contractnli: answered P 0.81 / R 0.91. Honest
  nuance: 2 cuad answered cells carry verbatim right-document quotes
  with ZERO gold overlap (relevance misses, not fabrications — the
  maud:002 pattern); they drag answered-only P and are the checker-
  free residual this bed exposes.
- **P4 held.** All 11 residual misses are typed declines; zero
  abstentions, zero fabrication.

Verdict: precision guarantees are structural — coverage rose 7× with
no invariant breached. Retrieval remains the residual lever: pool
recall at the winner config is 0.29 @k=4 but **0.52 @12 / 0.68 @24 /
0.85 @48** — the gold IS in the lexical pool, ranked below the cut.
Next lever (Eli authorized flat-rate model spend for retrieval):
LLM reranking of a deep pool (k≈24–48 → top 4), which bounds recall@4
at 0.68–0.85 without any embedding infrastructure; dense lane
reconsidered only if reranking underdelivers.

## Stage 16 — structure-native retrieval program (pre-registered
2026-07-30; Eli authorized flat-rate model spend for retrieval and
directed a research-grounded plan)

Research anchors: whole-pool listwise reranking (RankGPT family;
long-context models rank a 48-candidate pool in one call);
parent-child / hierarchy-aware chunking validated on legal corpora
(HiChunk; a MAUD chunking benchmark; parent-document retrieval as
pushed by the LegalBench-RAG authors themselves); contextual chunk
prefixes (Anthropic contextual retrieval). Our angle: the skeleton
makes chunk boundaries and context prefixes deterministic, and the
citator supplies proposition-level surrogates no generic stack has.

Workstreams, in execution order, each gated on deterministic gold:
- **W2 (now, model spend): whole-pool LLM reranker.** Pool k=48
  lexical (t1600/o120/w16, measured pool recall 0.8486), one listwise
  call (luna@low) returns the best 4 passage indices; parse failure
  falls back to lexical order (typed, counted). Frozen predictions:
  reranked recall@4 ≥ 0.40 (lexical 0.2865; pool bound 0.85);
  precision@4 ≥ lexical (0.0303); doc recall ≥ 0.98 unchanged;
  fallback rate < 5%. Falsified by: recall@4 < lexical (reranker
  destroys order), or fallback ≥ 20% (transport-shaped, not scored).
- **W1: skeleton-aligned chunking + context prefixes** (free,
  offline): clause/heading-boundary chunks for contracts, heading-path
  + doc-identity prefixes in indexed text; ablate vs t1600 winner.
- **W3: citation short-circuit lane** — queries containing citations
  resolve deterministically via citation_lookup, RRF-fused first.
- **W4: proposition-surrogate index** (product corpus): parentheticals
  / citator excerpts as an embedded+lexical retrieval lane routing to
  opinion passages; attacks the Stage 13 CLERC no-sub floor via
  richer attested offers.
- **W5: dense lane** (fastembed ONNX local; turbovec at product
  scale) — only if W1+W2 leave recall@4 < 0.5.

### Stage 16 W2 verdict (776 tests, luna@low ranking calls, 0 errors
→ `stage16-rerank-eval.jsonl`) + W1 null

All four registered predictions held, no falsifier fired:
- Reranked R@4 **0.6697** vs paired lexical 0.4012 (same k=48 pool,
  perDocCap 24; the Stage 15 confirm config with cap 2 measured
  0.2865 — combined lift 2.3×). Prediction ≥0.40: held at 1.7× the
  bar. The reranker captures 79% of the 0.8486 pool bound.
- P@4 doubled, 0.0437 → 0.0876 (≥ lexical: held).
- doc@4 0.9987 (≥0.98: held).
- Fallbacks **0/776** (<5%: held). Mean 5.1s/ranking call.
W5 gate: recall@4 0.67 ≥ 0.5 — the dense lane stays closed.

W1 executed with an honest null (commit `45e70fc1`): heading-path
context prefixes in a dedicated FTS column measured slightly negative
on this bed (R@4 0.2865 → 0.2763 at weight 2) — headings are
regex-guessed on plain-text contracts and queries don't use heading
vocabulary. Ships default-off; its customer is the product skeleton
lane where true heading paths exist.

### Stage 16 confirm run (pre-registered): grounding over reranked
retrieval. Same 32 cells, sol@medium, required_slot, passage
t1600/o120/w16 pool k=48 → luna@low rerank → top 4 →
`stage16-lbrag-rerank.jsonl`. Frozen: answered ≥ Stage 15's 21/32;
unlocated quotes 0 (post-locator); answered ∩ gold-doc-miss ≤ 1;
answered-only grounded P ≥ 0.077; errors < 20%. Falsified by:
answered-only P < 0.077 or any unaudited unlocated quote.

### Stage 16 confirm results (32 cells, sol@medium over reranked
retrieval, 0 errors → `stage16-lbrag-rerank.jsonl`)

All five frozen predictions held, no falsifier fired:
- **Answered 26/32** (≥21 bar; pilot was 3/32 this morning, Stage 15
  21/32). Zero abstentions; residual = 4 typed declines + 2 gate
  rejections. cuad flipped 0 → 7 answered.
- Unlocated quotes 0; answered ∩ gold-doc-miss 0; doc recall 1.00
  everywhere.
- Answered-only grounded P **0.5841** — above Stage 15's 0.4429, so
  precision ROSE while coverage rose; 76× the original retrieval
  baseline. Answered-only R 0.5031. contractnli: P 0.90 / R 0.82.
- maud remains the hard slice (answered-only P 0.073 — gold spans are
  narrow deal-point clauses; quotes land near but not on them).

Session arc, same 32 cells, all invariants intact end to end:
answer rate 3/32 → 21/32 (passage retrieval) → 26/32 (reranking),
answered precision 0.44 → 0.58, zero fabrications, zero
wrong-document answers, zero transport errors. Retrieval was the
bottleneck and two measured levers removed most of it; next levers
are W3/W4 (citation short-circuit; proposition surrogates on the
product corpus, targeting the Stage 13 CLERC floor).

### Stage 16b — reranker preview ablation (120 paired cells →
`stage16b-preview1600.jsonl`)

The listwise reranker showed candidates truncated at 500 chars —
half-blind over 1600-char passages. Re-ran the rerank eval bed at
preview 1600, paired on the same 120 cells (30 per source, luna@low):
rerank R@4 **0.5624 → 0.7615**, zero parse fallbacks. Per source:
cuad 0.63 → 0.92, privacy_qa 0.59 → 0.90, contractnli 0.84 → ~1.0,
maud 0.18 → 0.23 (maud's ceiling is chunking, not the reranker —
the clause-mode lever). `retrievalRerank.ts` default preview is now
1600. Stage 17's frozen config predates this change and runs at
preview 500; preview 1600 rides the Stage 18 bundle.

## Stage 17 — the full-bed honest verdict (pre-registered 2026-07-30;
Eli: "drive us home ... tested honestly on the hardest benchmark
tasks")

The 32-cell bed validated levers; the finished-system claim needs the
FULL LegalBench-RAG mini: all 776 tests (194 per source), including
the slices the 32-cell bed showed hardest (maud deal-point clauses;
answered-only P 0.073 there). Config held at the crowned stack:
sol@medium composition, required_slot, passage t1600/o120/w16 pool
k=48 → luna@low listwise rerank → top 4, 300s timeout →
`stage17-lbrag-full.jsonl` (resumable).

Frozen predictions (from the 32-cell confirm, with honest margins for
bed variety):
- P1 (soundness, unconditional): zero verbatim-tier false passes;
  every unlocated quote audited (locator defect vs gate defect —
  only an unaudited or gate-defect case falsifies); answered ∩
  gold-doc-miss ≤ 1% of answered cells.
- P2 (coverage): answered ≥ 60% overall (32-cell measured 81%).
- P3 (precision floor): answered-only grounded char P ≥ 0.077
  overall (32-cell 0.58); reported per source with maud expected
  weakest — per-slice numbers reported, not gated.
- P4: residual failures typed (declined/rejected/abstained), never
  fabrication; errors < 10%.
Falsified by: any P1 breach; answered-only P < 0.077; errors ≥ 10%.

### Stage 17 verdict (2026-07-30): the crowned stack HOLDS on the full bed

All 776 cells completed (194 per source). Seven cells erred in the main
pass (two Codex 503s; five on a runner accounting bug — `usage`
undefined dereference at `legalbench-rag-grounding.ts` merge, fixed with
optional chaining, model work unaffected) and were re-run to completion
via `--resume 1` at the frozen config. The resume path pins
`--rerank-preview 500` (new flag): the reranker's module default moved
to 1600 (Stage 16b) after launch, and one receipt file must never mix
rerank configs. Final outcomes: **651 answered (83.9%), 87 declined, 34
rejected, 4 abstained, 0 errors.**

Gates (scored from `stage17-lbrag-full.jsonl`, dedupe = last non-error
row per test_id):

- **P1 (soundness) — holds under audit.** Verbatim tier: all 1,358
  quoted spans across the 651 answered cells re-verified against the
  corpus files under the locator's declared contract (CRLF preserved,
  quote glyphs/whitespace-runs normalized) — **zero false passes**.
  (First audit pass showed 276 "mismatches"; all were audit artifacts —
  Python CRLF translation shifting offsets plus curly-quote glyphs —
  not runner defects.) Unlocated quotes: 0, nothing to audit.
  Answered ∩ gold-doc-miss: literal 7/651 = 1.08%, a hair over the ≤1%
  line — audited individually: **6 of 7 quote
  `cuad/ADUROBIOTECH...CONSULTING AGREEMENT.txt`, byte-identical
  (12,020 chars) to the gold `...AGREEMENT(1).txt` twin** — the quoted
  text IS the gold text under a duplicate filename (upstream CUAD
  corpus duplicate), and char scoring already punishes them (P=R=0).
  The one true wrong-doc answer is contractnli:152 (answered from
  AGProjects NDA; gold was the Eskom template) = 0.15% of answered.
  Recorded as: literal breach by half a cell, resolved by audit to a
  corpus-duplicate artifact; true unsound-document rate 0.15%.
- **P2 (coverage) — PASS.** 651/776 = 83.9% answered (gate ≥60%;
  32-cell bed measured 81%).
- **P3 (precision floor) — PASS.** Answered-only grounded char
  P = 0.5050, R = 0.5114 (gate ≥0.077; 32-cell 0.58). Per source
  (answered-only P / R): contractnli 0.7592/0.7857 (179 answered),
  cuad 0.5544/0.6588 (161), maud 0.1429/0.1114 (142), privacy_qa
  0.4928/0.4163 (169). maud weakest as predicted — narrow deal-point
  gold vs. chars-mode chunking; the registered Stage 18 levers (clause
  mode, stitching) target exactly this slice.
- **P4 (typed residuals) — PASS.** 0 final errors (transients resumed
  to completion); every non-answer is typed (87 declined / 34
  rejected / 4 abstained), never fabrication.

Baseline comparison (all non-error cells): raw retrieval-span scoring
at the same k gives P = 0.0865, R = 0.6604 over a mean 5,557 quoted
chars/cell; the harness answers with P = 0.5050 over a mean 779
chars/cell — **5.8× the precision at 1/7th the quoted text**, which is
the program's claim in one line: the contract turns high-recall sludge
into small, verbatim, located answers, and refuses in type when it
cannot. Mean cell latency 17.8 s (p90 25.3 s).

Verdict: **not falsified — the finished-stack claim stands on the full
LegalBench-RAG mini.** The honest residual is maud's precision (0.14):
a chunk-granularity problem, not a soundness problem, and the
pre-registered Stage 18 bundle (clause-mode chunking + preview 1600 +
stitching/child-rank) is the follow-up.

### Published-score calibration (fetched 2026-07-30, arXiv:2408.10343)

Frame of reference for all char-level numbers in this log. The
LegalBench-RAG paper's own baselines (OpenAI text-embedding-3-large,
naive vs RCTS chunking; Cohere rerank HURT on every dataset) score, at
k=4 chunks, char precision contractnli 12.5% / cuad 6.0% / maud 2.2% /
privacy_qa 12.3% (best of the two chunkings) with recall@4 of 29.8% /
27.9% / 4.6% / 27.9%; even at k=64 chunks recall reaches only 86.6% /
75.7% / 28.3% / 84.2%. maud is brutal for everyone: paper P@1 2.65%,
R@64 28.3%. Against that: our lexical+rerank retrieval at k=4
(1600-char chunks) has recall 91% / 68% / 22% / 84% per source —
at-or-above the paper's k=64 numbers on three of four sources with
1/16th the chunks — and the harness's answered-only grounded char
precision 0.505 has no published counterpart (the paper benchmarks
retrieval only; nothing in it reaches 13% char precision at any k).
Vendor evals (Ragie) claim ~54% P@1, but under binarized per-chunk
scoring, not the paper's char-span formula — not comparable. Sources:
arxiv.org/abs/2408.10343; ragie.ai blog. Calibration: char precision
against minimal human gold spans saturates far below 1.0 (a perfect
clause quote scores <1 when gold marks a sub-sentence); contractnli
0.76 answered-P is near practical ceiling, and the exploitable gaps
are maud (pool recall) and quote-selection width elsewhere.

## Stage 18 — maud pool recall + grounded composition (pre-registered
2026-07-30, before any scored run)

Diagnosis from receipts (stage16b bed, n=120): pool R@48 per source is
contractnli 1.02 / cuad 0.92 / privacy_qa 1.02 — saturated, rerank R@4
0.90–1.0 — vs **maud 0.3494 pool, 0.2265 rerank R@4**. maud's pool is
the single binding retrieval constraint on the bed; everything else is
generation-side. Stage 17 grounded confirm: overall answered-only
P 0.505 / R 0.511, maud 0.143/0.111.

Arms (retrieval arms scored deterministically on ALL 776 gold tests,
free; rerank stage on the stage16b 120-cell bed at preview 1600,
luna@low; frozen config otherwise t1600/o120/w16, pool perDocCap 24):

- **R1 clause-mode chunking** (`mode: "clause"`, tiling, no overlap):
  predict maud pool R@48 0.3494 → ≥0.42 and maud lexical R@4 0.0948 →
  ≥0.13; saturated sources stay within −0.04 of chars-mode pool R@48.
  Falsified for maud if pool gain < +0.05; falsified overall if any
  saturated source drops > 0.06.
- **R2 phrase bigrams** (adjacent content-word pairs from the query as
  quoted FTS5 phrase OR-terms beside the unigrams): predict overall
  lexical R@4 0.3241 → ≥0.34, maud pool +0.02 or more, no source's
  pool R@48 down > 0.02. Dropped as flat if overall lexR4 gain < +0.01
  and maud pool gain < +0.02.
- **R3 composition** (clause + phrases) only if R1 and R2 are both
  individually non-negative on maud.
- **Rerank confirm**: winning retrieval config on the 120-cell bed,
  preview 1600 (paired vs stage16b receipts): predict maud rerank R@4
  0.2265 → ≥0.30.
- **G grounded confirm** (full 776-cell bed, sol@medium required_slot,
  same gates machinery as Stage 17): winning retrieval config +
  preview 1600 + evidence k=6 + adjacent-span stitching (post-rerank
  merge of same-doc spans within a 200-char gap, so narrow deal-point
  clauses straddling chunk joints arrive whole). Attribution note: G
  is a composition run — lever attribution lives in the retrieval-arm
  receipts above and the Stage 16b preview receipts, not in G.
  Predictions: overall answered-only grounded P ≥ 0.55 (from 0.505)
  and R ≥ 0.55 (from 0.511); maud answered-only P ≥ 0.25 (from
  0.143); answered ≥ 75%; P1 unconditional exactly as Stage 17
  (verbatim zero false passes; every unlocated quote audited;
  answered ∩ gold-doc-miss ≤ 1% of answered, byte-identical duplicate
  corpus files counting as hits per the Stage 17 audit rule); errors
  < 10% pre-resume. Falsified by: any P1 breach; overall answered-only
  P < 0.505 (strict no-regression); answered < 60%.
- **D dense lane (registered-deferred)**: hybrid BM25+dense through
  the standing `rrfFuse` plug-point, embeddings from a local model —
  blocked at registration: no local ollama binary and the desktop-PC
  tailscale endpoint (`OLLAMA_BASE_URL` in backend/.env) did not
  answer `/api/tags` when probed today. Registered so the intent and
  the plug-point are on record; runs when an embedding backend is up.
  Target when it runs: maud pool R@48 ≥ 0.50.

Aims, calibrated to the published scores above: Stage 18 success looks
like maud grounded P in the 0.25–0.35 band (paper's best maud char
precision at ANY k is 3.4%), overall answered-P ≥ 0.55, with soundness
untouched. contractnli is treated as at-ceiling; no lever targets it.

### Fair-comparison protocol (locked 2026-07-30, before the hold-out
burn; Eli: "measure it against public results honestly … as if we did
not let the model abstain")

Three scoring modes, all REQUIRED in every future headline report
(derived deterministically from the same receipts; Stage 17 values
below from `stage17-lbrag-full.jsonl`, deduped final rows):

1. **answered-only** (our operating metric; conditions on the 83.9%
   the system chose to answer — flattered by selection, always
   reported beside coverage): P 0.5050 / R 0.5114.
2. **forced-answer** (no abstention credit: non-answered cells score
   their top-4 retrieval spans — what the system would emit if forced
   to always answer): P 0.4375 / R 0.4833. Per source P: contractnli
   0.7047, cuad 0.4613, maud 0.1227, privacy_qa 0.4614.
3. **zero-credit** (harshest: every non-answer scores 0 — abstention
   counted as total miss): P 0.4236 / R 0.4290.

Reading: the abstention selection effect is worth ~0.07–0.08 P
overall — the score is not an abstention artifact. Even zero-credit
(0.42) sits 3–19× above the paper's per-source P@4 (2.2–12.5%).

Retrieval-only comparison (vs the paper's own metric, which is all the
paper measures): our post-rerank top-4 spans over ALL cells score
P 0.0865 / R 0.6604 (per-source R: 0.91/0.68/0.22/0.84) vs the
paper's best-chunking P@4 2.2–12.5% / R@4 4.6–29.8%. Known asymmetry,
recorded: our chunks are 1600 chars vs the paper's ~500-char RCTS —
bigger chunks depress char precision and inflate recall; a
chunk-matched retrieval arm (t500/o0, same scorer) rides the Stage 18
ablation for an apples-to-apples row. Other honest asymmetries: (a)
our bed is the first 194 tests/source of 6,858 (fixed pre-registered
subset; the Stage 19 hold-out — next 194/source, zero tuning — tests
subset fit); (b) possible pretraining contamination helps quote
SELECTION but cannot fabricate (verbatim gate); (c) overlapping gold
spans can push recall marginally above 1.0 (double-count, ≤0.02).

The Stage 19 hold-out burn happens ONCE, after Stage 18 freezes the
final config, and reports all three modes + retrieval-only, same
formulas, no re-tuning afterward.

### Stage 18 retrieval-arm verdicts (2026-07-30, receipts
`stage18-retrieval-arms.jsonl`, all 776 tests, deterministic)

**R1 clause mode: FALSIFIED** under its frozen terms. maud pool R@48
0.3619 → 0.3848 (+0.023, needed +0.05) and contractnli pool dropped
1.0529 → 0.9806 (−0.072, tolerance −0.06). (chars-mode numbers here
differ from the stage16b 120-cell bed — full-776 vs subsample.)
Clause mode did lift lexical R@4 (overall 0.4058 → 0.4189, cuad
0.184 → 0.254) but the pool is what the rerank eats, and the pool
didn't move. maud's pool constraint is vocabulary mismatch, not chunk
geometry — the dense lane (arm D, deferred) is the right lever.

**R2 phrase bigrams: FALSIFIED, strongly negative.** Overall lexical
R@4 0.4058 → 0.2489; contractnli 0.860 → 0.437. OR'd phrase terms
redistribute bm25 mass toward boilerplate-phrase-bearing passages.
The `phrases` option stays in the module as measured-negative
(off by default); a rank-fused phrase LANE (rrfFuse) is the correct
retry shape if ever revisited, not score-summed OR terms.

**R3 composition: moot** (needs both parents non-negative).

**Fair500 row** (chunk-matched retrieval comparison, t500/o0/w16
lexical-only k=4): P@4 0.0594 / R@4 0.1434 overall (contractnli
0.114/0.391, cuad 0.019/0.046, maud 0.028/0.018, privacy_qa
0.077/0.119) vs the paper's dense-embedding P@4 2.2–12.5% / R@4
4.6–29.8%. Honest reading: at matched conditions our raw BM25 is at
or below the paper's embedding baselines — the stack's edge is the
architecture (wide pool → listwise LLM rerank → verbatim contract),
not the lexical retriever. Recorded so nobody mistakes the headline
numbers for retriever magic.

**G final config (frozen):** retrieval unchanged (chars
t1600/o120/w16, pool 48, luna rerank), rerank preview 1600, evidence
k=6, stitch gap 200 (post-rerank same-doc merge; baseline lane stays
unstitched for Stage 17 comparability). Output
`stage18-lbrag-grounded.jsonl`. Predictions as registered above.

### Stage 18 R4 — rerank compute ablation (registered 2026-07-30,
before any cell ran; receipts `stage18-rerank-arms.jsonl`)

Eli's question: does a heavier model or a higher luna effort tier
change results? For the COMPOSER, Stage 13 answered it — effort
saturates at sol@medium, max effort was retired (2–4× latency, no
pass gain). The RERANKER has never been ablated on model or effort:
luna has run at its provider default (medium) since Stage 16, and the
rerank call path did not even plumb effort until now
(`completeText`/`rerankPassages` gained an optional `reasoningEffort`
pass-through; runner flag `--rerank-effort`, recorded in the
retriever id as `+rerank(model@effort)`, absent = default = every
prior receipt's config). Ranking is a different task shape from
composition (one listwise selection over 48 candidates), so Stage 13's
saturation result is a prior, not an answer.

Design (deterministic bed, LLM only at the rank step): for each test,
the crowned lexical pool (k=48, t1600/o120/w16, perDocCap 24 — byte-
identical across arms), one listwise rerank call per arm, char P@6 /
R@6 of the unstitched top-6 vs human gold. Unparseable replies fall
back to lexical order (typed `fallback` flag, reported per arm — a
rambling heavy arm fails closed, visibly). Bed: first 48/source (192
tests) × 5 arms = 960 flat-rate calls; any displacing winner confirms
on the full 776 before entering a frozen config. Holdout untouched.

Arms: `luna@default` (champion control, no effort param), `luna@low`,
`luna@high`, `sol@medium`, `terra@medium`.

Predictions (frozen): (1) luna is effort-insensitive for ranking —
low/high within ±0.02 R@6 of default; (2) no arm beats luna@default
by more than +0.03 overall R@6; (3) heavier arms (sol, terra) cost
≥2× rerank latency and do not lower fallback count. Displacement rule:
an arm replaces luna@default in a future config only if overall R@6
gain ≥ +0.03 AND no per-source R@6 regression > 0.03 AND fallback
cells ≤ champion + 2, then confirmed on the full bed. A cheap tie
(luna@low within 0.01) is recorded as a cost result, not adopted
pre-holdout.

### Stage 18 R4 verdict (2026-07-30, 960/960 cells, 0 errors,
concurrency 12, receipts `stage18-rerank-arms.jsonl`)

**No displacement — luna@default (provider medium) is confirmed the
best rerank seat; prediction 1 falsified in an instructive direction.**

| arm | R@6 | P@6 | fallback | maud R@6 |
| --- | --- | --- | --- | --- |
| luna@default | **0.7845** | 0.0790 | **0/192** | 0.2764 |
| sol@medium | 0.7773 | 0.0787 | 0/192 | 0.2630 |
| terra@medium | 0.7612 | 0.0766 | 9/192 | 0.2698 |
| luna@high | 0.7571 | 0.0788 | 55/192 | 0.2747 |
| luna@low | 0.6562 | 0.0618 | 41/192 | 0.2695 |

- Prediction 1 (luna effort-insensitive, ±0.02) **falsified**: low
  −0.128, high −0.027. But the mediator is FORMAT COMPLIANCE, not
  ranking ability — fallback (unparseable listwise reply → lexical
  order, fail-closed) runs 0% at default vs 21% at low and 29% at
  high. Low-effort luna gets sloppy with the JSON array; high-effort
  luna buries it. Effort deviation in either direction breaks the
  output contract more often than it improves the ranking.
  privacy_qa shows the damage concentrated where lexical order is
  weakest (low: 0.9494 → 0.4437).
- Prediction 2 held: nothing beat the champion at all, let alone by
  +0.03. A whole model tier up (sol) with zero fallback still ranks
  0.007 WORSE — listwise selection over 48 candidates is saturated at
  luna-medium capability.
- Prediction 3 (latency): unmeasurable as registered — the harness
  did not record per-call latency (honest gap; arms interleaved in
  one wall-clock window). Fallback comparison: sol ties default at 0;
  terra 9/192.
- Cross-confirmation of the maud diagnosis: every arm lands maud R@6
  at 0.26–0.28 against a pool ceiling of ~0.29 — no amount of rerank
  compute can rank what the pool never contains. maud is a pool
  problem (R5/dense lanes), not a rank problem.

Roster consequence: rerank seat frozen at luna@default preview 1600.
The effort plumbing stays (measured-negative options documented);
`--rerank-effort` should NOT be set in production configs.

### Stage 18 R5 — contextual enrichment (registered 2026-07-30,
before any header was generated; receipts
`stage18-passage-context.jsonl`)

Anthropic's contextual-retrieval pattern, aimed at the two measured
weaknesses: maud's pool constraint is vocabulary mismatch (R1
verdict), and chunk-matched lexical precision sits at/below the
paper's embedding baselines (fair500 row). One offline flat-rate call
per passage of the crowned index (~6k, luna@low, doc name + first
1500 chars of the document + the chunk) writes a 1–2 sentence
situating header. Headers live ONLY in the FTS `context` column of a
content-hash-keyed sidecar variant
(`PassageIndexOptions.contextJsonl`, unit-tested: distinct index
identity, plain path byte-unchanged, returned text still the verbatim
source slice) — retrieval output is unchanged in kind, so the
verbatim contract is untouched. Generation runs in a machine-free
window (background, low priority, API-bound).

Measurement (deterministic once headers exist): lexical R@4 + pool
R@48 on the enriched index at contextWeight ∈ {1, 2, 4} vs champion
(weight 0), same frozen bars as R1 for comparability: adopt only if
maud pool R@48 lifts ≥ +0.05 with contractnli pool regression within
−0.06; any adopted variant rides a later grounded confirm, never the
frozen G/holdout configs.

Honest prior AGAINST: heading-path context at weight 2 measured
slightly negative (R@4 0.2865 → 0.2763) — but those headings were
regex-guessed local structure; LLM headers carry document identity,
parties, and topic vocabulary the chunk itself lacks. Predictions
(frozen): maud pool R@48 +0.03 to +0.10; contractnli within
tolerance; weight 4 over-weights (worse than weight 1–2); enrichment
never lowers pool recall on any source by more than 0.03. Falsified
if maud pool moves < +0.03 at every weight — then vocabulary mismatch
is not header-bridgeable and the dense/proposition lanes are the
remaining levers.

**Amendment (registered 2026-07-30 before measurement, per Eli): the
attested-entity lint is itself an ablation arm, not an assumed
improvement.** The lint (deterministic: every capitalized header
token outside a structural whitelist must appear in the doc
text/name, with an alphanumeric-skeleton fallback absorbing
formatting variants; flagged headers drop to the heading-path
fallback) runs against the raw generation receipts, and the weight
sweep runs TWICE — `raw` (all non-error headers) vs `linted` — each
with its own hash-keyed sidecar and receipts
(`stage18-context-arms-{raw,linted}.jsonl`). Prediction (frozen):
linted ≥ raw on maud pool R@48 (dropped headers remove false lexical
bridges) or within noise (±0.01); the lint arm is falsified — and the
lint retired from the lane — if raw beats linted by > 0.02 maud pool
R@48, which would mean the drops delete more true vocabulary than the
hallucinations they prevent. Smoke stats on the first 406 headers:
3.94% drop rate pre-skeleton-fallback.

Generation ops note (recorded): c=12 tripped the codex 429 rate
limit on short low-effort calls (1,502/2,008 rows); generator gained
jittered exponential backoff; sustained c=4–5 runs clean (~1.5
headers/s).

### Stage 18 G verdict (2026-07-30, full bed, receipts
`stage18-lbrag-grounded.jsonl`, 776/776 cells, run completed;
2 error-final cells (0.26%) left as-is per Eli's "enough model
running" — no resume pass)

**Not falsified; G beats Stage 17 on every headline; two registered
predictions missed.** Config: sol@medium composer, required_slot,
k=6, `passage:t1600/o120/w16+rerank(luna)@p1600+stitch200`.

| metric | Stage 17 (k=4, no stitch) | Stage 18 G | Δ |
| --- | --- | --- | --- |
| answered | 651/776 (83.9%) | 681/776 (87.8%) | +3.9pp |
| answered-only P | 0.5050 | 0.5377 | +0.0327 |
| answered-only R | 0.5114 | 0.5708 | +0.0594 |

Per-source answered-only P/R: contractnli 0.7893/0.8491 (S17 P
0.7592), cuad 0.5822/0.7427, maud 0.1626/0.1070, privacy_qa
0.5241/0.4701. Outcomes: 70 declined, 20 rejected, 3 abstained,
2 error.

**P1 unconditional: CLEAN.** 1,552 quoted spans audited, 0
mismatches, 0 unlocated; 7 answered doc-misses, all byte-identical
duplicate-file artifacts (ADUROBIOTECH class), TRUE doc-misses 0.
Audit amendment, recorded: the Stage 17 audit normalized quote
glyphs only; Stage 18's wider evidence (k=6 + stitch) pulled in
documents with non-breaking spaces and multi-space formatting (DoiT
NDA, ACCELERATEDTECHNOLOGIES, ACCURAY), surfacing 20 apparent
mismatches that all resolve under whitespace-class normalization
(nbsp→space, run collapse). The harness's `locateQuote` is
documented whitespace/quote-glyph-tolerant while yielding exact
original coordinates, so the audit now mirrors that equivalence
class — verified 20/20 resolve, then 0 mismatches.

**Fair-comparison modes (locked protocol):** answered-only P 0.5377 /
R 0.5708; forced-answer P 0.4808 / R 0.5436; zero-credit P 0.4731 /
R 0.5022; retrieval-only over all cells P 0.0707 / R 0.8097 (k=6
spans are wider than S17's k=4: retrieval R rose 0.6604 → 0.8097,
P fell 0.0865 → 0.0707 — the composer, not the pool, converts that
recall into precision).

**Prediction misses, honest:** answered-only P 0.5377 < 0.55
predicted; maud P 0.1626 < 0.25 predicted (maud did move
0.1429 → 0.1626, +14% relative, and maud answered rose 126 → 141 —
direction right, magnitude short). R 0.5708 ≥ 0.55 and answered
87.8% ≥ 75% both hit. Falsifiers (P < 0.505, answered < 60%, any
true P1 breach) all clear. Reading: k=6+stitch is a real, mostly
recall-shaped win; maud's precision problem is retrieval vocabulary
plus clause-boundary granularity, which the registered R4/R5/dense
lanes target — composition is not the maud bottleneck.

**Stage 18 G is the new champion config.** Holdout (next 194/source)
stays unburned until the R4/R5/dense results settle the final
config, per the lock-in rule.

### Stage 18 R5 verdict (2026-07-30, generation complete + dual
deterministic sweep; receipts `stage18-passage-context.jsonl`,
`stage18-passage-context-linted.jsonl`,
`stage18-context-arms-{raw,linted}.jsonl`)

**Middle band: real lift, adoption bar not met, falsifier not
triggered.** Generation: 5,979/5,984 passages headed (5 skipped on
empty doc text — fail-closed to the heading path; 1,508 stale 429
error rows in the file are superseded by resume, last-wins). Lint on
the full set: 115/5,979 flagged (1.92%, vs 3.94% on the smoke) —
contractnli 2.16%, cuad 3.08%, maud 1.71%, privacy_qa 0.75%; flagged
tokens are mostly benign unattested inferences ("African" for
Transnet/Eskom, "GAAP", "AAA" arbitration), not invented parties.

maud pool R@48 vs champion 0.3619: raw w1 0.3942 (+0.0323), w2
0.3896 (+0.0277), w4 0.4019 (+0.0400); linted w1 0.3961 (+0.0342),
w2 0.3860 (+0.0241), w4 0.3980 (+0.0361).

Gate judgments against the frozen bars:
- **Adopt (maud ≥ +0.05): NOT met** — best +0.0400 (raw w4).
- **Falsifier (< +0.03 at every weight): NOT triggered** — both arms
  clear +0.03 at w1 and w4. Vocabulary mismatch IS partially
  header-bridgeable.
- Predictions: maud +0.03..+0.10 HIT; contractnli within tolerance
  HIT (improved, 1.0529 → 1.0783); "weight 4 over-weights" MISS —
  w4 is the best weight on maud and overall (pool 0.8534 → 0.8842);
  "no source drops > 0.03" HIT (only privacy_qa dips, −0.0101).
- **Lint arm: prediction held, lint adds nothing.** Raw and linted
  are within ±0.01 at every weight (max gap 0.0039 at w4, raw
  ahead). Retirement bar (raw > linted by 0.02) not hit; verdict is
  the lint is a measured no-op on this bed — kept available as a
  guard for corpora with higher hallucination rates, not adopted as
  a default layer.

Off-target observation (recorded, not adopted — the gate was
maud-scoped): headers are broadly positive elsewhere. cuad pool
R@48 0.8946 → 0.9623 (+0.0677) and chunk-lexical R@4 0.1844 →
0.5512 at w4; overall lexical R@4 0.4058 → 0.5313. Any adoption on
a portfolio-level gate would be a NEW registered round riding a
grounded confirm, not a post-hoc rescope of this one.

### Stage 18 R5b — generator-effort contingency on maud (registered
2026-07-30 before any medium-effort header was generated)

R5 landed between the falsifier and the adoption bar, so the
registered contingency runs: is the header GENERATOR the lever?
Regenerate maud passages only (4,687) with luna at its default
medium effort, same prompt, same everything else. Combined sidecar =
raw low-effort file with the maud rows appended after (
`loadContextHeaders` is last-wins on duplicate keys), so only maud
headers change; contractnli/cuad/privacy_qa rows are byte-identical.
Sweep weights {1, 2, 4}, label `maud-medium`, receipts
`stage18-passage-context-maud-medium.jsonl` +
`stage18-context-arms-maud-medium.jsonl`.

Frozen predictions: medium lifts maud pool R@48 by < +0.03 over
low's best (0.4019) — identity vocabulary (deal, parties, target)
is already captured at low effort, and clause-concept vocabulary
lives in the chunk both tiers already see. Adopt only if maud pool
R@48 ≥ 0.4119 (champion +0.05, the R5 bar) at some weight with
contractnli within −0.06 (trivially satisfied — its headers are
unchanged). Generator-effort lane retired if medium ≤ 0.4029 (low's
best + 0.01) at every weight — then header quality is not the
residual lever and the dense/proposition lanes are what remains for
maud.

### Stage 18 R5b verdict (2026-07-30, maud-medium regeneration +
combined-sidecar sweep; receipts
`stage18-passage-context-maud-medium.jsonl`,
`stage18-passage-context-combined-medium.jsonl`,
`stage18-context-arms-maud-medium.jsonl`)

**ADOPT: generator effort was the residual lever — medium-effort maud
headers clear the frozen R5 adoption bar.** Generation: 4,692/4,692
maud passages headed at luna@medium (4,691 first pass at c=9, ~2.8
headers/s vs low's ~3.6; 1 transient "terminated" error filled by a
c=1 resume). Combined sidecar = byte-exact concatenation of the raw
low-effort file + the maud-medium rows (`loadContextHeaders` is
last-wins), so contractnli/cuad/privacy_qa headers are byte-identical
to R5's raw arm. A first build via `Set-Content -Encoding utf8` was
discarded: PS 5.1 writes a BOM that would corrupt the first JSONL row
for `JSON.parse`; the shipped file is a
`[System.IO.File]::ReadAllBytes`/`WriteAllBytes` concat.

maud pool R@48 (champion 0.3619; low-effort best 0.4019 at w4):
w1 0.4228, w2 0.4281, w4 0.4310. maud chunk-lexical R@4
0.0683 → 0.1628 (w2) / 0.1604 (w4).

Gate judgments against the frozen bars:
- **Adopt (maud pool R@48 ≥ 0.4119 at some weight, contractnli
  within −0.06): MET at every weight** — best w4 0.4310 (champion
  +0.0691); contractnli 1.0783 at w4, above its unchanged 1.0529
  baseline, so the guard is satisfied as registered.
- **Retirement (medium ≤ 0.4029 at every weight): not triggered.**
- Frozen prediction (medium < +0.03 over low's best 0.4019): HIT,
  narrowly — +0.0209 / +0.0262 / +0.0291 at w1/w2/w4. The
  registration under-called the compounding: medium's modest
  increment stacks on low's +0.0400 to a total header lift of
  +0.0691 over champion, clearing the +0.05 bar low missed alone.
  The prediction was right about the increment's size and wrong
  about its sufficiency.

Cross-source integrity: contractnli/cuad/privacy_qa pool R@48 match
the raw-low sweep at every weight (their header bytes are unchanged);
the only deltas are ≤0.006 lexR4 wiggles from corpus-wide BM25
document-frequency shifts introduced by the new maud vocabulary.
Overall at the adopted weight: pool R@48 0.8842 → 0.8915, lexical
R@4 0.5313 → 0.5339 — the best deterministic retrieval numbers of
the program.

**Adopted config delta:** the crowned index gains
`contextJsonl = stage18-passage-context-combined-medium.jsonl`
(sha `36D041F7…`) at context weight 4. Per the lock-in rule this
rides ONE grounded confirm run before the config freezes for the
Stage 19 holdout; the dense lane remains a separately-registered
open question (machine-free window required).

### Stage 18 R5b grounded confirm (registered 2026-07-30 before the
run; output `stage18-lbrag-grounded-ctx.jsonl`)

One grounded confirm of the adopted retrieval delta over the full
776-test bed: the G champion exactly (sol@medium composer,
required_slot, k=6,
`passage:t1600/o120/w16+rerank(luna)@p1600+stitch200`) plus the
combined-medium context sidecar at weight 4. The runner gains
`--context-jsonl`/`--context-weight`, and the retriever label
carries `+ctx(w4@<sha12>)` so receipts can never silently mix
header versions. Headers touch ONLY the FTS pool selection; the
reranker still previews verbatim passage text, and composition is
untouched.

Frozen predictions (G baselines: answered 87.8%, answered-only
P 0.5377 / R 0.5708; maud answered-only P 0.1626 / R 0.1070;
retrieval-only P 0.0707 / R 0.8097):
- maud answered-only R improves, band +0.01..+0.05 (the +0.069
  pool lift converts only partially through rerank + composition);
- non-maud sources move within ±0.02 answered-only P/R;
- answered rate 85–91%; retrieval-only R ≥ 0.8097.

Frozen confirm gates:
- **KEEP the sidecar** iff maud answered-only R ≥ 0.1170 (G +0.01)
  AND overall answered-only P ≥ 0.5277 AND R ≥ 0.5608 (G −0.01
  each).
- **DROP** if maud answered-only R < 0.1070 OR overall P < 0.5177
  OR overall R < 0.5508 (G −0.02) — retrieval-level gains that do
  not survive composition do not ship.
- Middle band: judgment recorded honestly with a bias to DROP —
  at config freeze, ambiguity favors the simpler champion.

After the verdict the retrieval config freezes; Stage 19 timing
still waits on the dense-lane decision per the lock-in rule.

### Stage 18 arm D dense lane run (registered 2026-07-31 before the
eval; Eli: "Start dense lane now"; receipts
`stage18-dense-pool.jsonl`)

Arm D was registered-deferred for want of an embedding backend. It
now runs fully local and deterministic-given-the-model: fastembed
ONNX `BAAI/bge-base-en-v1.5` on CPU, `OMP_NUM_THREADS=2` + Idle
priority per the resource lesson from the killed first attempt.
Pool machinery matches the rerank bed (k=48, perDocCap 24, upstream
char-recall formula).

Six pool arms per test: `lex` (plain champion pool), `ctx` (the
R5b-adopted header pool, w4), `dense` (name+text embeddings),
`densectx` (name+header+text — the dense analogue of the adopted
FTS config), `fused` = RRF(ctx, densectx) — the production-shaped
hybrid — and `fusedlex` = RRF(lex, dense) for attribution of the
header vs dense contributions.

Frozen predictions: dense-only maud lands between lexical 0.3619
and ctx 0.4310; header-enriched embeddings edge plain; fused maud
pool R@48 in the 0.45–0.52 band (material lift; the 0.50 target
uncertain).

Frozen gates (0.50 target held over from the original arm-D
registration):
- **OPEN** the lane (wire the rrfFuse hybrid into the production
  stack, riding its own grounded confirm) iff fused maud pool
  R@48 ≥ 0.50 AND no other source drops > 0.03 vs the ctx pool.
- **CLOSED** (retired for maud) if fused maud ≤ ctx maud + 0.01 —
  embedding infrastructure is not justified by ≤1pt of pool.
- Middle band: recorded, default CLOSED for the Stage 19 freeze
  (lock-in bias); revisitable post-holdout only as a new
  registered round.

### Stage 18 arm D amendment (2026-07-31, before any results
observed): backend moved to the 3080 Ti, model upgraded

The bge-base CPU run was killed twice for machine load (34 CPU-min
in, still inside the first passage matrix; full run projected
70–90 CPU-min). Eli: "Set up the strongest embedding model that
can fit on our desktop pc/3080ti" — the RTX 3080 Ti (12 GB) lives
on `oajd-desktop`, reachable over Tailscale SSH.

Amended: embedding backend is now `Qwen/Qwen3-Embedding-4B` fp16
via sentence-transformers CUDA on the desktop (strongest open
embedder that fits 12 GB unquantized; queries use the model's
instruction prompt, passages plain; max_seq 1024). Inputs
(`passages.jsonl`, `tests.jsonl`, combined header sidecar
`36d041f7…`) shipped to the desktop; `stage18-dense-pool.jsonl`
ships back to the receipt store. Pool machinery, six arms, and the
frozen OPEN/CLOSED gates are UNCHANGED. No dense/fused numbers
were observed under bge-base, so the model swap is not
results-contingent. The frozen prediction bands were calibrated
for bge-base and are held over as-is, with the honest note that a
stronger embedder plausibly overshoots them — band hits/misses
will be recorded against the original text.

### Stage 18 R5b grounded confirm verdict (2026-07-31; receipts
`stage18-lbrag-grounded-ctx.jsonl`, 776/776 cells, 0 errors after a
2-cell resume)

**KEEP — every frozen gate passes and every source improved.**
Retriever label recorded in every row:
`passage:t1600/o120/w16+ctx(w4@36d041f7d66b)+rerank(codex:gpt-5.6-luna)@p1600+stitch200`.

P1 unconditional, clean: 1,564 quoted spans, 0 verbatim mismatches,
0 unlocated quotes, doc-miss 7 raw — all 7 byte-identical duplicate
files (the known ADUROBIOTECH-class artifact), 0 TRUE.

Coverage and precision vs G: answered 693/776 = 89.3% (G 87.8%);
answered-only P 0.5535 (G 0.5377), R 0.5832 (G 0.5708). Per source
(ansP/ansR, G in parens): contractnli 0.8052/0.8578 (0.7893/0.8491),
cuad 0.6232/0.7689 (0.5822/0.7427), maud 0.1754/0.1385
(0.1626/0.1070), privacy_qa 0.5394/0.4809 (0.5241/0.4701).

Gate arithmetic: maud answered-only R 0.1385 ≥ 0.1170 KEEP bar;
overall P 0.5535 ≥ 0.5277; overall R 0.5832 ≥ 0.5608 — KEEP on all
three, DROP conditions nowhere near.

Predictions: maud R lift +0.0315 inside the +0.01..+0.05 band HIT;
answered 89.3% inside 85–91% HIT; retrieval-only R 0.8464 ≥ 0.8097
HIT. One band miss recorded honestly: cuad answered-only P moved
+0.0410, outside the ±0.02 "non-maud within noise" prediction — in
the favorable direction, and expected in hindsight since the
adopted sidecar carries (low-effort) headers for every source, not
only maud; the R5 off-target observation already showed cuad's pool
benefits most.

Fair-comparison modes (locked protocol): answered-only P 0.5535 /
R 0.5832; forced-answer P 0.5040 / R 0.5743; zero-credit P 0.4943 /
R 0.5209; retrieval-only over all cells P 0.0757 / R 0.8464. All
four modes improved over G — the sidecar is not an
abstention-selection artifact.

**The retrieval config is now frozen as G+ctx:** sol@medium
composer, required_slot, k=6,
`passage:t1600/o120/w16+ctx(w4@36d041f7d66b)+rerank(luna)@p1600+stitch200`.
The only remaining pre-holdout lane is arm D (dense), in flight
under its own frozen gates; its verdict either adds a hybrid pool
lane (after its own confirm) or closes, and then Stage 19 burns
once.

### Stage 18 arm D dense lane verdict (2026-07-31; receipts
`stage18-dense-pool.jsonl`, 776 rows; Qwen3-Embedding-4B fp16 on
the 3080 Ti per the amendment)

**OPEN — the fused gate is cleared by 13.5 points, with every
source improving.** Runtime: plain matrix 409.6s, ctx matrix
507.9s, queries 9.2s (the CPU attempt burned 34 min without
finishing one matrix). Pool R@48 by arm:

| source | lex | ctx | dense | densectx | fused | fusedlex |
| --- | --- | --- | --- | --- | --- | --- |
| contractnli | 0.9650 | 0.9878 | 0.9681 | 0.9721 | **1.0000** | 0.9989 |
| cuad | 0.8225 | 0.8885 | 0.9307 | 0.9633 | **0.9748** | 0.9415 |
| maud | 0.3489 | 0.4146 | 0.4598 | 0.5576 | **0.6351** | 0.5442 |
| privacy_qa | 0.9932 | 0.9846 | 0.9905 | 0.9919 | **0.9962** | 0.9967 |
| ALL | 0.7824 | 0.8189 | 0.8373 | 0.8712 | **0.9015** | 0.8703 |

Gate arithmetic: fused maud 0.6351 ≥ 0.50 OPEN bar; vs the ctx
pool no source drops (contractnli +0.0122, cuad +0.0863,
privacy_qa +0.0116) — OPEN on the frozen text, nowhere near the
CLOSED condition (ctx maud + 0.01 = 0.4246).

Predictions vs the held-over bge-base bands, judged against the
original text: dense-only maud 0.4598 ABOVE the 0.3619–0.4310
band MISS (overshoot); densectx > dense HIT (0.5576 vs 0.4598,
far more than "edges"); fused maud 0.6351 ABOVE the 0.45–0.52
band MISS (overshoot). Both misses are the flagged model-upgrade
direction — bands were calibrated for bge-base.

Attribution: headers and dense stack. dense alone (0.8373 ALL)
beats ctx (0.8189); adding headers to the embedded text is worth
+0.034 ALL / +0.098 maud on top of dense; fused beats fusedlex
(0.9015 vs 0.8703) — the R5b sidecar earns its keep inside the
hybrid too. Baseline note, recorded honestly: this eval's own
lex/ctx maud pools (0.3489/0.4146) sit slightly below the ablate
runner's numbers for nominally the same configs (0.3619/0.4310) —
a dump-path pool-construction delta; gates were judged against
the eval's own ctx arm as the exact comparator, which is the
harder bar here.

Per the frozen OPEN action, the rrfFuse hybrid must ride its own
registered grounded confirm before joining the frozen config;
until that confirm returns KEEP, the production config remains
G+ctx. Operational note for the confirm and beyond: query-time
dense retrieval requires an embedder (the 3080 Ti desktop over
Tailscale, or precomputed pools for fixed beds) — a real
deployment dependency the lexical stack doesn't have.

### Stage 18 arm D grounded confirm (registered 2026-07-31 before
the run; receipts `stage18-lbrag-grounded-fused.jsonl`)

Per the frozen OPEN action, the fused hybrid rides its own grounded
confirm before joining the config. Eli's deployment constraint,
recorded up front: production inference must work on the laptop;
the 3080 Ti lane is the quality ceiling ("good to know what the
3080ti can offer though, so let's see that through"). A KEEP here
crowns the fused config for the benchmark/ceiling lane only; any
production adoption requires a laptop-viable embedder measured in
its own registered round.

Config: the frozen G+ctx composition stack unchanged (sol@medium
composer, required_slot, k=6, rerank luna@p1600, stitch200), with
the lexical pool stage replaced by precomputed hybrid pools via the
new `--pool-jsonl` runner flag: `stage18-fused-pools.jsonl` =
per-test RRF(ctx-w4 lexical pool, densectx Qwen3-4B pool), 48
spans/test, regenerated on the 3080 Ti with a sanity assert that
fused maud pool R@48 reproduces the verdict run's 0.6351. The
retriever label becomes `passage:pool(<sha12 of the sidecar>)
+rerank(codex:gpt-5.6-luna)@p1600+stitch200` — the sidecar hash
pins the entire upstream pool construction. Runner injects pool
spans with text sliced verbatim from the pinned corpus (same
coordinates the P1 audit checks). c=6, full 776-cell bed.

Sidecar landed 2026-07-31: sanity reproduced fused maud R@48 =
0.6351 exactly; 776 rows; sha256
`67958D5292D2CA26FE02EB755BCE7939654469BEFE06400EB7DBF01A2E52066D`
(byte-exact after Tailscale transfer) → retriever label
`passage:pool(67958d5292d2)+rerank(codex:gpt-5.6-luna)@p1600+stitch200`.

Frozen gates (baselines = the R5b ctx confirm: maud ansR 0.1385,
overall ansP 0.5535 / ansR 0.5832):
- **KEEP** iff maud answered-only R ≥ 0.1585 (+0.02 over ctx)
  AND overall answered-only P ≥ 0.5435 AND R ≥ 0.5732 (each
  within 0.01 of ctx — the pool lift must survive composition
  without degrading the whole).
- **DROP** if maud answered-only R < 0.1385 (no lift) OR overall
  P < 0.5335 OR R < 0.5632.
- Middle band: default DROP for the Stage 19 freeze (lock-in
  bias); revisitable post-holdout only as a new registered round.
- P1 unconditional: any verbatim mismatch or TRUE doc-miss kills
  the lane regardless of scores.

Frozen predictions: maud answered-only R lands 0.17–0.25 (pool
+0.22 discounts heavily through rerank→k=6→composition); non-maud
sources within ±0.03 of ctx confirm on ansP/ansR; answered rate
87–92%; retrieval-only R over all cells ≥ 0.86 (ctx 0.8464).

### Stage 18 fused grounded confirm verdict (2026-07-31): MIDDLE band → default DROP; G+ctx stays the frozen config

Run: 776 cells, c=6, one transient timeout (maud:122) resolved by a
resume pass to `rejected`; 0 errors final. Receipts
`stage18-lbrag-grounded-fused.jsonl`, retriever label verified
uniform `passage:pool(67958d5292d2)+rerank(codex:gpt-5.6-luna)@p1600+stitch200`.

P1 (unconditional): PASS — 1,659 quoted spans, 0 verbatim
mismatches, 0 unlocated quotes, 5 raw doc-misses all byte-identical
duplicates (TRUE doc-miss = 0).

Scores vs the frozen gates (ctx confirm baselines in parens):

- maud answered-only R = **0.1449** (ctx 0.1385; KEEP bar 0.1585,
  DROP bar 0.1385) — above no-lift, far below the +0.02 KEEP bar.
- overall answered-only P = 0.5525 (bar 0.5435) — PASS.
- overall answered-only R = 0.6002 (ctx 0.5832; bar 0.5732) — PASS.
- **Verdict: MIDDLE → default DROP** per the registered lock-in
  bias. The frozen Stage 19 config remains G+ctx.

Full table (answered-only, ctx confirm in parens): answered 719/776
= 92.7% (89.3%); contractnli P 0.7876/R 0.8583 (0.8052/0.8578);
cuad 0.6689/0.8508 (0.6232/0.7689); maud 0.1712/0.1449
(0.1754/0.1385); privacy_qa 0.5288/0.4786 (0.5394/0.4809). Fair
modes: forced-answer 0.5215/0.6052; zero-credit 0.5119/0.5561;
retrieval-only over all cells 0.0831/0.9120.

Prediction audit: maud ansR 0.1449 **MISSED below** the frozen
0.17–0.25 band; answered 92.7% just above the 87–92% band;
retrieval-only R 0.9120 ≥ 0.86 HIT; non-maud within ±0.03 held for
contractnli/privacy_qa but cuad ansR overshot (+0.082).

Reading (recorded, not adopted): the dense-lane pool lift on maud
(+0.22 R@48) almost entirely fails to survive rerank→k=6→
composition (+0.0064 composed) — the maud bottleneck is now
demonstrably the rerank/composition stage, not pool recall. The
fused pools DID lift overall composed recall (+0.017), coverage
(+26 answered cells), and cuad ansR (+0.082) at flat precision —
real off-target gains, not adoptable post-hoc under the frozen
protocol. A fused lane remains revisitable post-holdout only as a
new registered round, and any production use additionally requires
a laptop-viable embedder (the 3080 Ti is the ceiling lane only).

### Stage 18 funnel attribution + decline audit (2026-07-31, receipt-only analysis, zero model calls)

Per-source loss attribution, pool R@48 → post-rerank k=6 retrieval
R → composed answered-only R (ctx confirm / fused confirm):

| source | poolR | k6-R | ansR | rerank loss | composition loss |
| --- | --- | --- | --- | --- | --- |
| contractnli | 0.9878/1.0000 | 0.9782/0.9937 | 0.8578/0.8583 | 0.010/0.006 | 0.120/0.135 |
| cuad | 0.8885/0.9748 | 0.8765/0.9516 | 0.7689/0.8508 | 0.012/0.023 | 0.108/0.101 |
| maud | 0.4146/0.6351 | 0.3411/0.4759 | 0.1385/0.1449 | 0.074/**0.159** | 0.203/**0.331** |
| privacy_qa | 0.9846/0.9962 | 0.9350/0.9395 | 0.4809/0.4786 | 0.050/0.057 | **0.454/0.461** |

Composition, not retrieval, is now the dominant loss everywhere.
privacy_qa is the single largest composition gap (0.94 gold in
context, 0.48 quoted). Decline audit (baseline R on non-answered
cells): privacy_qa non-answers are 100% timid (19–22 cells with
baseline R ≥ 0.5 — gold in context, model declined/rejected
anyway); maud ctx-confirm non-answers were mostly justified (28/42
baseline R < 0.05) but fused non-answers were majority-timid
(16/29 ≥ 0.5) — the better pools turned justified declines into
timid ones. Motivates the coverage round below (general mechanism:
quote everything responsive; never decline over responsive
passages — not benchmark-specific).

### Stage 18 C1 coverage-composition confirm (registered 2026-07-31 before the run; receipts `stage18-lbrag-grounded-coverage.jsonl`)

Config: the frozen G+ctx stack unchanged (sol@medium composer,
required_slot, k=6, ctx-w4 retrieval, rerank luna@p1600,
stitch200), plus ONE new prompt module `coverage` appended to the
three registered modules (base/roles/quote_contract), arm label
`required_slot+coverage` via new `--coverage` runner flag:

> "Quote comprehensively: every supplied passage that answers any
> part of the question gets its own quotation claim — multi-part
> questions need the clause for each part; do not stop after the
> first supporting passage. Omit a passage only when it adds
> nothing beyond what is already quoted. If any passage bears on
> the question, answer with quotes rather than declining; decline
> only when no passage is responsive."

Full 776-cell bed, c=6. Frozen gates (baselines = ctx confirm:
overall ansP 0.5535 / ansR 0.5832, maud ansR 0.1385):
- **KEEP** iff overall ansR ≥ 0.6032 (+0.02) AND overall ansP ≥
  0.5435 (within 0.01) AND maud ansR ≥ 0.1485 (no regression
  beyond +0.01 noise).
- **DROP** if overall ansR < 0.5832 (no lift) OR overall ansP <
  0.5335 OR maud ansR < 0.1285.
- Middle band: default DROP. P1 unconditional.

Amendment (registered 2026-07-31 before any run, per Eli's
direction — treat complex contracts as webs of related concepts,
the legislation-"compiler" idea; model the contract internally
before answering): a second arm **C1b** = coverage module PLUS a
`spec` module (arm label `required_slot+coverage+spec`, receipts
`stage18-lbrag-grounded-covspec.jsonl`, own `--spec` flag):

> "Before composing, build an internal spec of the supplied
> passages as a web of related concepts: map defined terms to
> their definitions, follow cross-references between passages, and
> note which passages qualify, extend, or carve out exceptions to
> the others. Then answer the question against that web, quoting
> every passage that plays a role — the definition, the operative
> clause, and any exception or cross-referenced qualifier."

Both arms run the full 776 bed at c=6, judged against the SAME
frozen gates above. Adoption rule: the KEEP arm with the higher
overall ansR joins the frozen config for BOTH Stage 19 holdout
arms (tie → simpler module, C1a); if neither KEEPs, holdout burns
the unmodified frozen config.

Frozen predictions: C1a — privacy_qa ansR 0.55–0.75 (the 0.45
composition loss at least halves); maud ansR 0.17–0.28; overall
ansR 0.62–0.70; overall ansP flat to −0.03; answered rate 93–97%.
C1b — at or above C1a on maud/privacy_qa ansR (the web reaches
definition+operative+exception nodes); risk side recorded: longer
answers may pull ansP down as far as −0.04 vs ctx.

### Stage 18 F fairness round (registered 2026-07-31 before any run; motivated by an independent adversarial methodology review)

An adversarial review of Stages 14–18 identified places where the
program may be fitting the benchmark's structural artifacts — every
LegalBench-RAG question is answerable from the corpus, and every query
names its own document ("Consider <document identity>; <question>") —
rather than the product. This round measures each of those cheaply,
before the Stage 19 holdout burn spends its one shot. A Canadian
in-house holdout was raised by the same review and ruled OUT OF SCOPE
by Eli 2026-07-31.

**F1 — name-stripped retrieval audit** (deterministic, zero model
calls). Every benchmark query is templated "Consider <document
identity>; <question>", so lexical retrieval can be scoring the
document name rather than the question. New ablate-runner flag
`--strip-consider` removes everything through the first `;` (inclusive,
plus following whitespace) from a query that starts with `Consider `
before retrieval; other queries are unchanged. Run the frozen G+ctx
deterministic retrieval config over all 776 tests, stripped vs
unstripped, reporting per-source doc recall and pool R@48. No gate —
this is an audit, and its result is REPORTED at Stage 19 beside the
headline: if the stripped config collapses, the crowned retrieval
numbers are flagged as partly a query-format artifact rather than
product retrieval quality. Registered prediction: stripped doc recall
drops ≥0.10 absolute overall; maud and cuad drop most.

**F2 — negative-control composition arm** (gold document removed). New
grounding-runner flag `--exclude-gold`: after retrieval and before
rerank, drop every hit whose `filePath` is a gold document for that
test — plus any corpus doc whose full text is byte-identical to a gold
doc's full text — then proceed with the survivors (k unchanged; if
fewer than k survive, run with what remains). On such cells the honest
outcome is a decline/abstention: the answer is not in the supplied
passages. Three arms, per-source 25 (100 cells each): base modules;
+coverage; +coverage+spec. c=6. Receipts
`stage18-lbrag-f2-{base,coverage,covspec}.jsonl`.

Registered metric: **false-answer rate** = fraction of cells answered
WITH a conclusion claim that asserts a substantive answer (vs correctly
declining, or answering that the supplied passages do not address the
question).

Registered adoption condition, layered onto C1 BEFORE any F2 result is
observed (recorded honestly: the C1 arms were mid-flight and a partial
contractnli peek had occurred at the time this was registered) — a C1
arm may join the frozen config ONLY if its F2 false-answer rate does
not exceed the base arm's by more than 5 points absolute.

Prediction: base declines ≥80% of gold-removed cells; coverage and
covspec suppress justified declines, landing 10–30 points of
false-answer rate above base. If that happens the coverage contract
must be REWORKED in a future registered round (e.g. keep "quote
comprehensively", drop "answer rather than declining") — not adopted
as-is on its C1 ansR lift.

**F3 — plain-prompt control arm** (prices the grounding contract). New
grounding-runner flag `--plain` replaces the three registered prompt
modules with a single module:

> "Answer using the grounded-answer tool. Quote the supplied passages
> that answer the question, exactly as written."

The claim-typing schema is still enforced by the tool itself, so this
prices the *prompt* contract, not the machinery. One arm, per-source 49
(196 cells), frozen G+ctx retrieval, c=6, receipts
`stage18-lbrag-f3-plain.jsonl`. No gate — it prices the contract's
marginal value on this bed. Prediction bands: plain ansP 0.45–0.60
(within 0.05 of the champion at the same cells is NOT guaranteed), ansR
0.55–0.70, decline rate <5%.

**Reporting amendments** (protocol, reporting-only, apply from the C1
verdict onward):
1. Per-source answered-only P and R are always shown, never overall
   only.
2. A strict-answered column (answered requires ≥1 quotation claim AND
   ≥1 conclusion claim) is reported beside the loose answered rate.
3. The byte-exact quote rate is reported beside the normalized P1 audit
   number.

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
| `stage6-h6.jsonl` | `F79FDEB8C530281AB3DD247BA7CAF50D6FE2E5B5D0837DECEBD35B506C774615` |
| `stage7-h7.jsonl` | `6ED54A338EA3B7AE04F3E20ACEF0D9D240FB39E120D8C641EE1D484A39E26DED` |
| `stage8-h8.jsonl` | `2E51CB52786FB289DC78FA759FD3178B0BA6752EFC9190BAF51B7FC7C595714C` |
| `stage8b-h15h16h17.jsonl` (haiku lane stopped early per Eli) | `F7C3861B9669D7963512CED1FB623928EA3FD221008B088D289589F015592067` |
| `stage9-smoke.jsonl` | `7D3CA498A0A29300C1F26B068871C6CCC204B69674E530042471E06DB00AE4C8` |
| `stage9-h19h20.jsonl` (flat_recency live; A/B policy lanes postponed) | `7AA340C88F1D625D9765C9840D632AA451CEA0CBA625B27ED0B5D8BFE3BB675A` |
| `stage10-smoke.jsonl` | `E8CDD06D030F85B5361CF9F6F2AED52B9361580ADE3D273E1764CA538C9DCCF0` |
| `stage10-h18.jsonl` (persist transport; first 36 cells banked from the pre-relaunch pass) | `2F62B5D140044AC8F4F7119186DB44181CD4D8D51E39575693F7214056D4E7DC` |
| `stage11-smoke.jsonl` | `0301AFF421752C3FF36680124D1F53A2292D0167DC7F00089F2ABEFB09D578FE` |
| `stage11-luna-baseline.jsonl` | `185FAE297F9895753A29EA0609915F70A387B94EDBD85C79B6E4D56F000FC71C` |
| `stage12-claude5.jsonl` (cut mid-run per Eli; transport-falsified) | `951FAC9DBA05921520C2175DB77E55CD0F639FF3893789908AC9BF5C359B064E` |
| `stage12b-transport-probe.jsonl` | `D84CC55053009ED6F6D0536F0543FA74C0079EDCBCB5FC1CBCCAA45C76BEDA3A` |
| `stage13-ladder.jsonl` (luna@max, terra@max, sol@medium; sol@max no-op'd on the resume-key flaw) | `808AED56F24C5D36939A49F126A71AB64CD5D2CF85CBFD7D90E1F0A5F6C4D9C4` |
| `stage13-solmax.jsonl` | `C2225BF9ADA4C6011F3F6111AF4BF8E4541D8BDB7BB8435D610703BB46111A05` |
| `stage14-lbrag.jsonl` (pilot, pre-locator-fix scoring; maud:002 re-scored offline per the P1 audit) | `5720B4F97641655EE8C08F9D6EE9DED897E1492D9096AA684E5B46DD8AB7FD10` |
| `stage15-lbrag-passage.jsonl` | `595C123915066647D739AB1A5388488C08A12909FE6DA5B33DC5524615C7DDB6` |
| `stage16-rerank-eval.jsonl` | `107D021AEEA0594C95961F9F82CE7558ED95E56940FBAF1F75E637D905AE28E3` |
| `stage16-lbrag-rerank.jsonl` | `8DB2AC1DF0EBF9D0227C0820CB79BA1E86BBAABE5B0BF3DB48C761AA07602174` |
| `stage16b-preview1600.jsonl` | `C9C59D8EF859C1974457348FA66EA172F1466CC6D0109B579A51286175FBFDE4` |
| `stage17-lbrag-full.jsonl` (784 rows incl. 8 superseded error rows; resume passes appended) | `F117396886C52B10365ECB334A304F675C63D576FDB21E3039034C42F828DCF1` |
| `stage18-retrieval-arms.jsonl` (R1/R2 deterministic arms, all 776 tests) | `66689E7F6EB513348A167665C9D53BF02F807DDBDE61D409C52DDA88A0D23164` |
| `stage18-lbrag-grounded.jsonl` (G confirm, 776 rows; survived a mid-run machine restart via two resume passes, c=6 then c=3) | `BF2ED3965651565A75BE407BE1463B800F9B9F7246A6FCB58C96B52993A9D6E9` |
| `stage18-rerank-arms.jsonl` (R4 compute ablation, 960 cells, 0 errors) | `CC8837B79B962A17D385C3B5E16157F9B89B2C8DE00E3B967C77A03C759C0D9C` |
| `stage18-passage-context.jsonl` (R5 raw headers, 5,979 good rows + 1,508 superseded 429 rows) | `07A11F18F47BA689C637D33DCBF0BA50E02B5AF4AAD4CC37C1ABB02BEC1EE350` |
| `stage18-passage-context-linted.jsonl` (R5 lint arm, 5,864 kept / 115 dropped) | `946B6B79ABC0E1E7C0AEB467E420FC1163CBC10F204F9AFE12E3D177F5C865BE` |
| `stage18-context-arms-raw.jsonl` (R5 weight sweep, raw sidecar) | `0EF5A805090D885539AFB85113C3C02064842D94267B48EFAD07AE75B819943C` |
| `stage18-context-arms-linted.jsonl` (R5 weight sweep, linted sidecar) | `521095FE9058C3182717075626EA11CDB27E09DD1708A995E17330412773B33F` |
| `stage18-passage-context-maud-medium.jsonl` (R5b maud headers at luna@medium, 4,692 rows incl. 1 superseded error row) | `CBDC6994F3C012F87CAE67BF48D50843D302B443E507893E73F9035178C4C594` |
| `stage18-passage-context-combined-medium.jsonl` (R5b adopted sidecar: raw low-effort file + maud-medium rows, byte-exact concat, 12,180 lines) | `36D041F7D66B6F39C99D47078C88BF9F45F3FAF18ED054B5E8EA6640F231397E` |
| `stage18-context-arms-maud-medium.jsonl` (R5b weight sweep, combined sidecar) | `9FA97EAE337F9F7F7D54FE53E5BAA9B424354F4A8E68782CE5A1226048982F38` |
| `stage18-lbrag-grounded-ctx.jsonl` (R5b grounded confirm, 776 cells + 2-cell resume, 0 errors) | `11A4FB9A32D27679E8E8A7BBBDAEFF9E22228B950F68C093F8AA2D2B32DE751C` |
| `stage18-dense-pool.jsonl` (arm D six-arm pool eval, Qwen3-Embedding-4B on the 3080 Ti, 776 rows; sha verified byte-exact after Tailscale transfer) | `857848D409648EB39805E1593A2D997C6096F021D7C8F7235AB7B84B1021F7C9` |
| `stage18-fused-pools.jsonl` (fused pool sidecar, 776 rows, sanity 0.6351 reproduced; byte-exact after Tailscale transfer) | `67958D5292D2CA26FE02EB755BCE7939654469BEFE06400EB7DBF01A2E52066D` |
| `stage18-lbrag-grounded-fused.jsonl` (fused grounded confirm, 776 cells + 1-cell resume, 0 errors final) | `3FB273AB584962B951B753337F76B3DA355E1B3045510772EB8DD486FA5B1480` |

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

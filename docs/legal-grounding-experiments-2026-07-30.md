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

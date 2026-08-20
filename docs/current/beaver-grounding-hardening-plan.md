# Beaver attribute-first grounding implementation handoff

Status: **approved experimental design; not approved for production or live
model spend**

This handoff replaces the earlier proposal to reorder two fields in
`submit_grounded_answer`. That proposal did not implement the research it
cited. The implementation target is now the full, decomposed in-context
learning pipeline from *Attribute First, then Generate* (AFAG), followed by a
legal-domain comparison against Beaver's current answer path.

The reference is:

- Slobodkin et al., [*Attribute First, then Generate: Locally-attributable
  Grounded Text Generation*](https://aclanthology.org/2024.acl-long.182/), ACL
  2024, especially sections 2–3, 4.3, 5.1, and Appendix C; and
- the authors' [Apache-2.0 reference
  implementation](https://github.com/lovodkin93/attribute-first-then-generate)
  at commit `cc7b995dfb288da7982ae388994f182bef030b75`.

Do not call a field-order change, an evidence precommitment tool, post-hoc
citation matching, or a same-model verifier “AFAG.” None has the causal shape
tested in the paper.

The pinned upstream implementation map is:

- `few_shot_experiments/run_full_pipeline.py:35-88` — stage sequencing;
- `few_shot_experiments/subtask_specific_utils.py:256-302` — selection and
  clustering parsers;
- `few_shot_experiments/run_iterative_sentence_generation.py:75-239` —
  current-cluster context construction, prefix accumulation, and isolated
  generation calls;
- `few_shot_experiments/utils.py:352-380` — retry wrapper;
- `few_shot_experiments/prompts/LFQA.json` — exact prompts and demonstrations;
  and
- `few_shot_experiments/configs/test/LFQA/*.json` — released test settings.

## Decision in one diagram

```text
existing Beaver research/retrieval
        │
        │ question + exact model-visible source passages
        ▼
┌────────────────────────────────────────────────────────────┐
│ 1. CONTENT SELECTION — fresh isolated model call           │
│ Copy minimal, consecutive, verbatim answer-bearing spans.  │
└──────────────────────────────┬─────────────────────────────┘
                               │ host resolves exact spans,
                               │ offsets, hashes, and IDs
                               ▼
┌────────────────────────────────────────────────────────────┐
│ 2. SENTENCE PLANNING — fresh isolated model call           │
│ Group selected spans into ordered sentence clusters.       │
└──────────────────────────────┬─────────────────────────────┘
                               │ host verifies a complete,
                               │ duplicate-free partition
                               ▼
              ┌────────────────────────────────┐
              │ for each cluster, in order     │
              │ fresh isolated model call      │
              │                                │
              │ question                       │
              │ + current highlighted sources │
              │ + previously written prefix   │
              │             ↓                  │
              │ generate exactly next sentence│
              └───────────────┬────────────────┘
                              │
                              ▼
           sentence inherits that cluster's exact spans
                              │
                              ▼
          existing Beaver evidence registry and renderer
```

AFAG begins **after retrieval**. It does not find authorities, decide what is
good law, or replace Beaver's source/version/citation machinery. It changes how
the final answer is synthesized from the source passages that research made
visible to the model.

## The exact flaw in Beaver today

### The core generation flaw

`backend/src/lib/chat/prompts.ts` tells the model to select the smallest
supporting blocks before drafting. Production does not enforce that order.
`backend/src/lib/chat/legalEvidence.ts` accepts one terminal submission shaped
as:

```ts
{ claims: [{ text, evidence_ids }] }
```

The model can therefore formulate an entire proposition from its parametric
knowledge or from the broad conversation, then attach a related passage. The
host subsequently proves that the handle is registered and that quotation or
copying rules passed. It does not prove that the passage caused, entails, or
fully supports the already-written proposition.

This matters because one current support unit may contain 4,000 characters and
cite up to 16 passages. One supported clause can sit beside an unsupported
qualification, speaker attribution, exception, or legal conclusion and still
pass the reference-validity checks.

Putting `evidence_ids` before `text` in the same JSON object does not solve the
problem. Autoregressive field order is, at most, a cheap control condition. It
does not perform span selection, sentence planning, restricted per-sentence
generation, or attribution inheritance.

### Beaver's old `evidence_first` arm did not test AFAG

`backend/experiments/legal-evidence/legalEvidenceExperiment.ts` previously
tested a preliminary `plan_grounded_evidence` call. The model classified the
bundle as sufficient or insufficient and selected whole evidence handles, then
wrote the whole answer in a later call.

That arm had no verbatim subspan selection, no highlighted source context, no
ordered sentence clusters, and no fresh call per sentence. Its over-refusal,
latency, and transport failures falsify that precommitment design. They do not
falsify AFAG and must not be used as evidence against it.

## What actually needs to change

The MVP requires five things:

1. A new experimental AFAG orchestrator that takes the original question and
   the exact source passages already retrieved by Beaver.
2. A deterministic span resolver and plan validator: selected text must map to
   one source range, and the sentence plan must use every selected span exactly
   once.
3. Fresh, restricted calls for selection, planning, and each sentence. The
   existing research continuation must not leak into synthesis.
4. A child-span projection so the exact selected subspans, rather than their
   whole parent blocks, can pass through Beaver's existing evidence registry
   and citation renderer.
5. A paired evaluation showing whether the final legal answers are more
   accurate or easier to verify at an acceptable call, token, latency, and
   reliability cost.

Nothing else is needed to test the idea. In particular, the MVP does not need
a semantic verifier, another evidence store, a new retrieval system, a field
reordering in `submit_grounded_answer`, or routine revalidation of receipts
that Beaver just generated from immutable source text.

The only adjacent production-routing defect worth keeping in scope is that a
public-law research request should enter the grounded synthesis path because
the host routed it there, not because the final prose happened to contain a
case-name-shaped string. That routing change belongs to production promotion,
not to the initial AFAG experiment.

Do not describe a reference-valid receipt as a semantic verdict: Beaver
correctly records semantic support, coverage, and authority as `not_run`.

## What the paper actually implements

The paper's full prompt-based LFQA pipeline has three stages.

### 1. Content selection

The model receives the question and all supplied documents. It copies minimal,
consecutive, verbatim spans that answer the question. In the released LFQA
prompt, spans are grouped by `Document [n]`, separated by `<SPAN_DELIM>`, and
the total target is roughly 100 words with a maximum of 200.

The host parses the response, removes empty/punctuation-only spans, and locates
the spans in the source text. The paper says undetectable spans are omitted.
The released code matches after normalizing spaces and punctuation and may move
a span to another matching document.

### 2. Sentence planning

The host inserts `<highlight_start>` and `<highlight_end>` around the selected
spans and numbers the highlights across documents. The model receives the
question and highlighted documents and returns ordered clusters:

```json
[{"cluster":[1,2]}, {"cluster":[3]}]
```

Each cluster is intended to contain the spans that can be fused into one output
sentence. Cluster order is intended sentence order. For attention and context
length, each document is truncated after its final selected highlight.

### 3. Sequential sentence generation

For each cluster, the released runner makes a separate model call. That call
receives:

- the question;
- only documents containing a highlight in the current cluster;
- those documents with only the current cluster's markers retained and text
  truncated after the final current highlight; and
- all previously generated sentences as the prefix.

The call produces the next sentence and is instructed to cover all and only
the current highlights while connecting to the prefix. Formally, the paper
models the next sentence as:

```text
p(s[i+1] | s[1..i], C[i+1])
```

The current cluster becomes that sentence's attribution. The authors' runner
uses independent ordinary API calls. It does not carry one conversational or
provider session across stages or sentences.

### Released LFQA settings

These settings are the reproducible reference condition, not universal legal
defaults:

| Stage | Demonstrations | Temperature | Total attempts | Context shaping |
| --- | ---: | ---: | ---: | --- |
| content selection | 4 | 0.3 | 5 | full supplied bundle subject to input limit |
| sentence planning | 1 | 0.1 | 5 | truncate each document after its final highlight |
| sentence generation | 2 | 0.1 | 5 | current-cluster documents only; truncate after final current highlight; include prefix |

Copy the reference prompt resources and examples from the pinned Apache-2.0
repository into the experiment with an attribution header and commit hash. Do
not paraphrase them from memory.

## What the evidence supports—and what it does not

For LFQA, the paper reports the following automatic results:

| Method | ROUGE-L | BERTScore | AutoAIS | cited tokens per sentence | sentences without attribution |
| --- | ---: | ---: | ---: | ---: | ---: |
| decomposed AFAG | 35.8 | 90.5 | 78.7 | 65.2 | 0.0% |
| AFAG combined planning/generation | 38.6 | 90.7 | 89.3 | 48.2 | 0.0% |
| ALCE document citations | 35.2 | 89.9 | 49.8 | 2153.3 | 26.9% |

The human LFQA comparison was primarily between ALCE and the **combined**
AFAG variant, not the full decomposed pipeline this plan implements first. It
reported:

- sentence support of 94.4 versus 87.6;
- verification time of 35 seconds versus 59 seconds; and
- helpfulness of 4.5 versus 4.7.

Inter-annotator agreement on a 101-sentence attribution subset was only fair
(`Fleiss' kappa = 0.37`). The paper also reports greater compute, slower
execution, pipeline error propagation, and cases where generation imported
information from nearby unhighlighted context. Results differed on the
summarization task: the decomposed prompt-based AFAG arm's automatic
attribution score was lower than ALCE's there (`79.5` versus `88.7`), despite
far shorter cited text.

Accordingly, the paper warrants a faithful legal-domain experiment. It does
not warrant immediate production promotion or a claim that AFAG proves legal
correctness.

## Faithful implementation versus deliberate hardening

Implement the paper's declared algorithm, not every omission in its research
parser.

| Item | Required treatment |
| --- | --- |
| three-stage causal order | reproduce exactly |
| verbatim consecutive selected spans | reproduce exactly |
| highlighted in-context planning | reproduce exactly |
| ordered span clusters | reproduce exactly |
| fresh call per cluster | reproduce exactly |
| current-cluster documents plus prefix | reproduce exactly |
| attribution inherited from the cluster | reproduce exactly |
| official prompt templates, demos, and settings | preserve as the reference condition |
| missing/duplicate highlight assignments | reject deterministically; the released parser fails to enforce its own task contract |
| unknown highlight indices or empty clusters | reject deterministically |
| span matching | accept exact matches; optionally recover one unique normalized match and receipt `match_kind`; reject ambiguity and never silently move a span to another source |
| one-cluster legal answer | allow it; the paper's “at least two” condition is dataset-specific, not part of the AFAG factorization |
| retries | keep five total attempts, but freeze demonstrations and seed; receipt every attempt rather than randomly changing unrecorded state |
| persistent provider continuation | prohibit it; each stage/sentence must start with exactly the specified context |
| one-sentence generation | preserve the reference prompt and reject empty or multiline output; receipt a standard-library sentence-count diagnostic, but do not add a custom legal sentence parser before observed errors justify it |

These host checks do not add a semantic verifier or change which decisions the
model makes. They make invalid bookkeeping impossible and make every recovery
auditable.

## Implementation work

### Work package 1: build the faithful experiment

Keep all new orchestration in `backend/experiments/legal-evidence/`. Production
must not import it.

Create:

```text
backend/experiments/legal-evidence/
  attributeFirst.ts
  attributeFirst.test.ts
  attributeFirstRunner.ts
  attribute-first-reference.ts
```

`attribute-first-reference.ts` contains the pinned prompt templates,
demonstrations, settings, upstream URL, license, and commit hash.

`attributeFirst.ts` owns four dependency-free operations:

```ts
selectContent(input, callModel): Promise<SelectionResult>
resolveSelectedSpans(sources, rawSelection): ResolvedSelection
planSentences(input, callModel): Promise<SentencePlan>
generateSentences(input, plan, callModel): Promise<AttributedAnswer>
```

The orchestrator composes those operations. `callModel` is injected so tests
use fixtures and the runner uses `streamChatWithTools`. Do not add a second LLM
adapter.

The frozen input is:

```ts
type AttributeFirstInput = {
  question: string;
  sources: Array<{
    sourceIndex: number;
    evidenceId: string;
    citation: string;
    text: string;
    sourceSha256: string;
    exactSpanSha256: string;
  }>;
};
```

Only passage receipts whose exact text was serialized to the research model
may enter this bundle. AFAG must not broaden the model's source capability.

The resolved span is host-owned:

```ts
type SelectedSpan = {
  highlightIndex: number;
  parentEvidenceId: string;
  sourceIndex: number;
  start: number;
  end: number;
  text: string;
  exactSha256: string;
  matchKind: "exact" | "unique_normalized_recovery";
};
```

Resolve against the exact `sources[sourceIndex].text`. Preserve the submitted
raw string and the canonical source slice. Reject a missing or ambiguous span.
Reuse the production `createTextSourceDoc`, `sourceDocQuoteWords`, and
`sourceDocPhraseSpans` primitives. Try a byte-exact substring first; use the
word-span index only for a single normalized recovery. Do not import the A2AJ
experiment's quote resolver or add another tokenizer. Reject overlapping
selected spans in the same source rather than merging them silently.

The validated plan is an ordered partition of `1..N`:

```ts
type SentencePlan = Array<{ highlightIndices: number[] }>;
```

Require every selected highlight exactly once, no unknown indices, no empty
cluster, and at least one cluster. Do not infer or repair a cluster silently.

For each cluster, construct the prompt afresh. Retain unhighlighted surrounding
text as the reference implementation does, but remove documents with no
current highlight and truncate each included document after its last current
highlight. Pass the accumulated prefix as plain text. Do not supply the full
chat transcript, research tool catalog, prior cluster prompts, or a provider
continuation ID.

The final experimental output is:

```ts
type AttributedAnswer = {
  sentences: Array<{
    text: string;
    highlightIndices: number[];
  }>;
  spans: SelectedSpan[];
};
```

Each sentence's attribution is assigned by the host from its cluster. The
generation model never chooses citations after writing the sentence.

### Work package 2: deterministic tests before any calls

Use small, hand-written source fixtures. Tests must prove observable contracts:

- official-format content-selection output parses;
- exact consecutive spans resolve to correct source-relative offsets;
- one unique normalized recovery is labelled and canonicalized;
- missing, ambiguous, wrong-document, and nonconsecutive selections fail;
- overlapping or duplicate selections fail;
- highlights are inserted without changing source bytes outside markers;
- planning context stops after each document's final selected highlight;
- a valid plan is accepted;
- omitted, duplicate, unknown, and empty-cluster plans fail;
- one cluster is allowed;
- every generation call sees only current-cluster documents, the question,
  and the exact prior prefix;
- no generation call receives a continuation ID;
- sentences inherit the host's cluster spans without a model-authored link;
- raw outputs and failed attempts survive in the receipt; and
- abort preserves a valid partial receipt after every completed stage and
  sentence.

Run only focused experiment tests and the experiment boundary check during
development. No production source may import these files.

```powershell
npm run test:experiments --prefix backend -- experiments/legal-evidence/attributeFirst.test.ts
node scripts/check-source-boundaries.mjs
```

### Work package 3: an efficient, receipted runner

`attributeFirstRunner.ts` reads frozen JSONL inputs, runs cases with bounded
parallelism, and appends one event after every model attempt and completed
stage. It must support resume by case key, never rewrite completed cases, and
report progress. Raw provider output is mandatory.

Every case receipt includes:

- pipeline/prompt/parser versions;
- reference repository commit;
- model, effort, service tier, and attempt settings;
- question and source-bundle hashes;
- exact source IDs and source hashes;
- raw and parsed output for every selection/planning/generation attempt;
- selected span offsets, canonical text, hashes, and match kind;
- validated clusters;
- exact context hash for every isolated sentence call;
- prefix hash and current-cluster IDs;
- usage, latency, retry reason, and terminal status; and
- final answer and sentence-to-span attribution.

Do not put full source text repeatedly in every event. Freeze the source bundle
once and refer to its hash in later events. This keeps the ledger small without
losing byte-for-byte reproducibility.

The model prompts should likewise contain only what the reference stage needs.
Do not serialize receipt hashes, URLs, provider metadata, tool schemas, the
research transcript, or prior stage raw output into them. Selection receives
the question and source text; planning receives the question and highlighted
source text; each sentence call receives the question, its highlighted source
documents, and the prefix. Record prompt byte/token counts so any later prompt
or demonstration change has an explicit context cost.

### Work package 4: compare final legal performance

The first comparison has three paired, order-randomized arms over the same
questions and frozen source bundles:

1. current production whole-answer submission;
2. one-call `{evidence_ids, text}` order plus input-dependent ID enums—the
   cheap causal-control arm, not AFAG; and
3. the full decomposed AFAG pipeline.

Hold model, reasoning effort, retrieved sources, question, and answer-length
instruction constant. Use fresh isolated calls for the AFAG arm. Do not score
selection, clustering, and generation as separate product tasks; inspect their
receipts to explain final mistakes.

Judge the final answer on:

- legal answer correctness;
- material unsupported propositions;
- material omissions and lost qualifications;
- wrong court, party, counsel, quotation, majority/minority, or temporal voice;
- attribution support and attribution length;
- time for a reviewer to verify the answer from its displayed spans;
- input, cached-input, output, and reasoning tokens;
- provider calls, retries, wall time, and completion rate; and
- total cost under the same service tier.

The evaluation set must include single- and multi-source synthesis, cases,
legislation, journals, conflicting authority, quoted/counsel material, and
insufficient-source controls. Freeze it before reviewing candidate outputs.
Use human legal gold for promotion-critical outcomes; machine judgments may
triage but cannot define correctness.

AFAG is useful only if it moves the final system's Pareto frontier. Do not
promote it for a small attribution gain bought with a large correctness,
coverage, token, latency, reliability, or verification-time loss. Freeze a
numeric promotion threshold after baseline variance is known and before the
candidate labels are opened.

### Work package 5: production promotion only after a win

If the decomposed arm wins, promote the proven operations into the normal
runtime/application path and delete the replaced one-call composition path.
Beaver has no users; do not add compatibility modes.

The production research agent remains responsible for retrieval. When it has
registered the source passages needed for an answer, it terminates research
without drafting prose. The application operation then runs isolated AFAG
composition from the original question and the registered, model-visible
passages.

Do not place AFAG inside one persistent Codex/OpenAI/Claude continuation. The
research session may be persistent; every AFAG stage and sentence call must be
fresh and receive only its declared inputs.

Final selected subspans should become child receipts in the existing evidence
registry. Add one production helper in `legalEvidence.ts`:

```ts
deriveLegalEvidenceSpan(parentReceipt, { start, end })
```

It retains the parent's source identity, source hash, legal locator, provider,
version, and provenance; derives a child block identity from the parent block
plus relative offsets; slices canonical span text; recomputes exact and
normalized span hashes; and mints the normal evidence ID. Existing citation
presentation, viewer links, chat pills, DOCX rendering, prior-turn
rehydration, local mode, and cloud persistence consume that ordinary receipt.
There is no second evidence ledger or citation framework.

Route the new orchestration through the shared runtime/application operation
and existing persistence ports. Do not branch on local/cloud and do not import
an adapter into feature code.

## Adjacent cleanup, explicitly outside the MVP

- Correct documentation that says child blocks were selected before prose;
  production currently instructs that behavior but does not enforce it.
- If the legacy one-call arm remains as an experiment control, its known
  evidence IDs may be an input-dependent enum. That makes malformed control
  outputs rarer but is not an AFAG feature.
- Validate or recompute a stored receipt only at a boundary where corruption,
  untrusted import, partial persistence, or version mismatch is genuinely
  possible. Do not hash-check a same-turn receipt again, and do not repeatedly
  revalidate a content-addressed receipt for immutable reported case law merely
  because it is being read.
- If persisted receipt integrity ever becomes a demonstrated problem, validate
  once on ingestion/deserialization or rely on the persistence layer's normal
  integrity guarantees. Keep that work separate from semantic grounding.

## Supporting literature

AFAG supplies the implementation pattern. The other papers define what must be
measured or kept separate:

| Work | Use here |
| --- | --- |
| [AIS](https://doi.org/10.1162/coli_a_00486) | Defines attribution to identified sources and separates attribution from source quality and overall answer quality. |
| [ALCE](https://aclanthology.org/2023.emnlp-main.398/) | Supplies the document-citation baseline and distinguishes citation correctness from citation completeness. |
| [FActScore](https://aclanthology.org/2023.emnlp-main.741/) | Shows why a long sentence/support unit can mix supported and unsupported atomic facts; use it to design corruptions and review units, not to force maximal claim splitting in production. |
| [Grammar-constrained decoding](https://aclanthology.org/2023.emnlp-main.674/) | Supports input-dependent structural constraints, such as allowable highlight indices; it does not establish semantic support. |
| [QUIP](https://aclanthology.org/2024.eacl-long.140/) | Supports measuring lexical copying/quotation separately from semantic grounding. |
| [MiniCheck](https://aclanthology.org/2024.emnlp-main.499/) | A possible evaluation-only checker after legal calibration; it is not part of AFAG and is not approved as a production gate. |

## Do not do

- Do not ship the field-order change as the AFAG fix.
- Do not reuse `plan_grounded_evidence` as the selection stage.
- Do not combine planning and generation first; the full decomposed pipeline is
  the auditable reference condition. Test the paper's cheaper combined variant
  only after the reference arm works.
- Do not reuse a hot provider session across AFAG calls.
- Do not give every sentence the full research context.
- Do not silently drop, duplicate, move, or invent selected spans.
- Do not treat exact matching, citation presence, model agreement, or a clean
  receipt as entailment.
- Do not add a new citation store, semantic-verification service, dependency,
  or local/cloud fork.
- Do not make live model calls without explicit authorization.

## Handoff completion checklist

The implementation agent is done only when:

- the pinned reference prompts/settings and attribution are present;
- the three stages and per-cluster fresh calls match the reference algorithm;
- deterministic fixture tests prove span and cluster invariants;
- raw, resumable receipts make every prompt/output/context reconstructable;
- no production file imports experiment code;
- the three-arm protocol is frozen before any live output is judged;
- results report final legal quality and full efficiency cost together; and
- production remains unchanged unless the legal-domain experiment earns
  promotion.

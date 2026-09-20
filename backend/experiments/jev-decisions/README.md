# Jev decision benchmarks

Three opt-in, read-only benchmarks: grounded-claim verification, categorical
Tabular Review, and fixed-candidate legal search reranking. One Node 22.13+ runner,
no added dependency, no application/test-suite changes, no automatic promotion.

The fixtures are **invented protocol examples, not adjudicated legal gold**. A
perfect smoke result means the transport/scorer works, not that Jev is accurate.
No live inference was used to build this experiment. See [RESULTS.md](RESULTS.md).

## Run locally

From the repository root (the same commands work in PowerShell):

```sh
node --test backend/experiments/jev-decisions/harness.test.mjs
node backend/experiments/jev-decisions/cli.mjs smoke --out backend/experiments/jev-decisions/runs/smoke
```

Use a fresh smoke directory. This writes `inputs/all.input.jsonl`, separate
`all.gold.jsonl`, per-task input/gold files, a frozen plan, receipts and report.
It performs no HTTP/model calls; focused tests also exercise the actual HTTP
adapter against a local server. These native Node tests are deliberately separate
from both production Vitest and the TypeScript experiment suite.

Create editable input examples without running the smoke:

```sh
node backend/experiments/jev-decisions/cli.mjs fixtures --out backend/experiments/jev-decisions/runs/examples
```

Plan a real dataset without credentials, transmission or spend:

```sh
node backend/experiments/jev-decisions/cli.mjs plan --input backend/experiments/jev-decisions/inputs/verify.input.jsonl --model jev-latest --out backend/experiments/jev-decisions/runs/verify-choice
```

Inspect `plan.json`: it contains every exact state, question, source/input hash,
request hash and byte count. Oversized requests are refused, never truncated or
silently split into additional paid calls. Default byte cap is 96,000 including
questions; it is a conservative host guard, **not a tokenizer or a guarantee of
fitting the provider's token limit**. Token-limit rejections remain failed calls.
Replace `jev-latest` with an available pinned model ID for a comparative run; the
runner records requested and returned identifiers without inventing a snapshot.

A live Jev run additionally requires `TYPESAFE_API_KEY` in the environment and
explicit authorization for metered calls. Never paste a key into arguments/files.
The repository's no-spend rule remains the default; the following is an opt-in
command for an operator who has separately authorized the spend:

```sh
node backend/experiments/jev-decisions/cli.mjs run --input backend/experiments/jev-decisions/inputs/verify.input.jsonl --model jev-latest --out backend/experiments/jev-decisions/runs/verify-choice --max-calls 100 --workers 4 --allow-live --allow-metered
node backend/experiments/jev-decisions/cli.mjs score --run backend/experiments/jev-decisions/runs/verify-choice --gold backend/experiments/jev-decisions/inputs/verify.gold.jsonl --out backend/experiments/jev-decisions/results/verify-choice.json
```

`--max-calls` is an invocation call-count ceiling, not a dollar ceiling. No transport
retry is hidden. Requests that have never started can resume using the same command
and directory; successful, rejected and failed calls do not retry. A checkpoint left
`started` after a crash becomes `interrupted`: its remote outcome/billing is unknown.
Start a separately named run for an intentional retry and include both runs' costs.
A lock prevents concurrent writers; after a crash remove `.lock` only after confirming
the old process is dead. A changed dataset, code, model or configuration refuses resume.

Ctrl+C/SIGTERM abort active requests and leave unstarted work pending. Nonzero run exit
status means at least one planned call did not succeed. Failures and budget-exhausted
pending work remain in scoring denominators. Raw outputs are hashed and retained;
credentials are not. Files are owner-only where the operating system supports it;
use a private directory with appropriate Windows ACLs for confidential material.
`--allow-private` is additionally required to transmit packets marked private.

## Conventional-model control

Reuse Beaver's existing `streamChatWithTools` provider boundary. From `backend`,
with the normal backend dependencies/selected provider configured:

```sh
node --import tsx experiments/jev-decisions/cli.mjs run --input experiments/jev-decisions/inputs/verify.input.jsonl --provider beaver --model codex:YOUR_CONFIGURED_MODEL --out experiments/jev-decisions/runs/verify-control --max-calls 100 --workers 2 --allow-live
```

The caller exposes no tools, starts no persistent session, permits one provider
iteration and one attempt, and sends the identical state/questions. It requests
answers-only JSON and retains the original text, actual provider usage and context
round receipts. `codex:`, `claude-p:` and `ollama:` are the non-metered opt-in routes;
other provider models additionally require `--allow-metered`. Provider configuration
still determines the actual billing/data handling. No example is authorization.

Conventional probabilities are explicitly labelled **elicited estimates**, not
native log probabilities. The existing transport does not return a resolved model
snapshot, so `reported_model` stays null. This is a controlled decision comparison,
not a performance claim against Beaver's full agent, generative explanations or
multi-column extraction pipeline. The adapter's invocation contract is locally
tested; actual provider integration needs an authorized configured runtime.

## Frozen input and gold

Each input JSONL row has these exact fields:

```text
id, task: verify|tabular|rerank, group, split: development|calibration|test,
slice: natural|adversarial|<named-slice>, privacy: public|synthetic|private,
input: { sources, passages, <task fields> }
```

`sources` is an array of `{source_id, version, sha256, text}`. Use the exact canonical
text addressed by the receipts, not a newly normalized copy. Hashes are SHA-256 of
UTF-8 text (plain hex or `sha256:` prefix). `passages` preserves Beaver-style
`evidence_id`, `stable_source_id`, `version`, `source_sha256`, `span: {start,end}`,
`span_text` and a human `locator` string. Optional `name`, `citation` and `opinion`
are strings. Offsets are half-open **JavaScript UTF-16 offsets**, not UTF-8 bytes or
Unicode code points. Every span must exactly equal its source slice. For receipts
with a structured locator, export its `.label` without changing the original ID.

This harness accepts frozen exports, not live Library access: retain source/version
identity and use the complete canonical source text only to validate/hash the packet.
The default model state contains just the supplied passages. `--context window`
adds up to 1,500 surrounding UTF-16 code units each side; `--context source` includes
complete supplied sources and may exceed the cap. The window is a character-context
ablation, not a promise to recover complete paragraphs or opinions.

Group related decisions, original/adversarial pairs and translations together **before
looking at predictions**. All rows in a group must have the same split. Verification
and tabular tasks also reject source identities/hashes crossing splits; reranking
allows a shared retrieval corpus and requires query-topic grouping. The runner cannot
infer undisclosed litigation families. Assign the intended 40/20/40 split in your
corpus manifest, then freeze it. `input_sha256` in gold is the SHA-256 of
`JSON.stringify(row.input)`; field order is intentionally part of the frozen packet.

Gold lives in another JSONL file with exactly one row per manifest item:
`{id, input_sha256, adjudication: human|synthetic|model_draft, ...}`.
Unknown input fields are rejected; the inference command has no gold argument.
Only the offline scorer joins gold. Large files are explicitly sharded at 64 MiB.
A scoped run needs a matching scoped gold file; missing/duplicate/stale gold fails.

### 1. Claim / treatment verification

Input adds `claim` and `cited_evidence_ids` (1..4 original passage IDs). A treatment
record can be expressed as an explicit proposition, treatment and opinion-attribution
claim, retaining the exact supporting passages from `a2aj-case-treatment`. Do not
silently project the old treatment gold as a new human audit.

Gold adds `label`: `supported`, `overstated_or_qualified`, `contradicted`,
`unaddressed`, or `insufficient_context`.

Compare `--verify-mode choice` with `decomposed` (relationship plus independent
attribution and qualification Nouls), then the three context modes. Context may
clarify the cited passage but is not permission to repair a wrong pinpoint. The
acceptance score is the minimum of supplied support/attribution/qualification
probabilities, **not their product or an asserted joint probability**.

Reports include the full confusion counts, relationship accuracy, material-error
detection recall, valid-claim pass rate, binary support calibration and unsafe-pass
risk/coverage. A transport failure is not credited as semantic error detection.
Automatic acceptance is never applied to production answers. Omission discovery,
whole-case re-extraction and one-repair end-to-end answer evaluation are not implemented.

### 2. Categorical Tabular Review

Input adds `scope_complete` and `columns: [{id,prompt,format,options?}]`.
`format` is `yes_no` or `tag`; tag `options` maps allowed keys to descriptions.
`not_found` and `ambiguous` are reserved and always explicit. Gold adds:

```json
{"cells":[{"column_id":"renewal","choice":"yes","evidence_sets":[["original-evidence-id"]]}]}
```

Each `evidence_sets` entry is one independently adjudicated, sufficient exact set.
There may be several alternatives. Merely overlapping a gold passage is not a pass.
A correct value with wrong/extra evidence fails complete-cell scoring. `not_found`
requires exhausted scope and no selected evidence; no answer is never coerced to No.

Each column receives a Choice and one evidence-selection Noul per supplied passage,
all independently against the same state. `--tabular-mode noul` adds affirmative and
negative Nouls for boolean columns; neither/both supported routes to the explicit
unknown options. It retains the auxiliary Choice to distinguish missing/ambiguous.
This ablation is not a one-Noul shortcut. Default evidence-selection threshold is .5;
choose it on development data and keep it fixed in calibration/test reports.

Compare question batches of 1, 4, 12, 24 and the default all, with both serial and
bounded-concurrent requests. `--batch-size` counts **questions**, not columns;
evidence questions are included in usage. Compare supplied-gold passage packets
against independently prepared production-retrieved packets as separate datasets.

Reports distinguish value accuracy, exact evidence accuracy, complete-cell accuracy,
false No and false Not Found, probability calibration and selective coverage. They
measure categorical values with evidence, **not generated explanations**. There is
no claim that Jev replaces the full `extractTabularAnswers` contract or its already
batched row reading. Numeric/date extraction, taxonomy design, fallback execution
and generated explanations remain outside this first decision harness.

### 3. Legal reranking

Input adds `query`; `passages` contains 1..50 candidates in the original provider
order. Gold adds `grades` mapping every candidate evidence ID to 0..3 and
`adverse_ids` for materially useful contrary passages. Include known relevant IDs
outside the pool in `grades` to distinguish retrieval misses from ranking mistakes.
Grades: irrelevant, background, materially useful, directly addresses the issue.
The denominator is your adjudicated pool, not claimed complete corpus relevance.

Compare `--rank-mode score`, `noul` and `choice`. All variants include a separate
candidate-pool answerability Noul; the shortlist Choice has a `none` option. Its
probabilities are relative to that shortlist, not absolute relevance probabilities.
The prompt treats contrary evidence and qualifications as useful. Ties retain the
original provider order. `--order reverse` reverses presented passages while keeping
the original baseline/tie order; use fresh output directories for each arm.

Reports include candidate-conditional nDCG@10, MRR, pooled recall@10, candidate recall,
adverse recall@10, original-order baselines and pool-answerability errors. No-answer
pools have undefined nDCG, **not perfect scores**; their answerability accuracy is
reported separately, including failures. A negative candidate-pool decision never
means the full corpus has no answer. Candidate acquisition, diversity constraints
and full research-answer generation are not replaced by this harness.

## Calibration and paired comparisons

```sh
node backend/experiments/jev-decisions/cli.mjs fit --run RUN_DIR --gold MATCHING_GOLD.jsonl --task verify --out POLICY.json
node backend/experiments/jev-decisions/cli.mjs score --run TEST_RUN_DIR --gold TEST_GOLD.jsonl --policy POLICY.json --out TEST_REPORT.json
node backend/experiments/jev-decisions/cli.mjs compare --left CONTROL_REPORT.json --right JEV_REPORT.json --task verify --split test
```

`fit` uses only human-adjudicated calibration rows. It selects coverage from a fixed
threshold grid subject to an upper Wilson bound on **groups with any accepted error**,
not an independence assumption about thousands of cells/repeats. Defaults: risk .01,
at least 20 accepted groups. Small datasets normally cannot meet that bound and
produce a **disabled policy**, never an invented threshold. The bound is a conservative
calibration selection aid, not certification after threshold search. Independent
held-out evaluation is still mandatory. Policies bind model, code, prompts/options
and evidence threshold; applying one rejects calibration source/family overlap.
No labels are read by inference and no policy is applied to product state.

Reports stay stratified by task, split, slice and gold-adjudication kind. Reliability
bins and Brier/log loss concern actual Noul or declared probability targets; a Noul
has no invented confidence field. Missing predictions cannot have a probability score
and are counted explicitly as missing rather than given an artificial probability.
For verification, only supported predictions are eligible; for tabular, ambiguous
or contract-invalid predictions are never eligible.

`compare` requires identical frozen gold and paired observations. It resamples
source/topic groups with all cells and repeats intact, uses 2,000 seeded bootstrap
samples, and reports right-minus-left deltas and an exploratory 95% interval. Choose
`quality`, `value_correct`, `answerability_correct`, `recall10` or `adverse_recall10`
as appropriate. It does not adjust for multiple comparisons or tune on test data.
`--repeats 3` retains every output for stability inspection without pretending that
three repeats are three independent documents.

Accounting retains actual usage even when a parsed answer is invalid. Unknown usage
is unknown, not zero-cost. Reported call latency, summed call time and session wall
time are distinct; none is full-product row latency. Dollar cost is null until you
apply current account pricing; include failed calls, deliberate reruns and downstream
read/generation/review costs in any end-to-end economic claim. No replay cache is used.

## References and integration boundaries

API verified against [TypeSafe HTTP reference](https://docs.typesafe.ai/api),
[primitives](https://docs.typesafe.ai/primitives),
[Choice](https://docs.typesafe.ai/primitives/choice) and
[Score](https://docs.typesafe.ai/primitives/score), September 15, 2026.
The adapter sends `POST /v1/systemone` with bearer authorization. Native probability
mass tolerates documented rounded examples (absolute sum error <=.025); scoring
normalizes that rounding while raw answers remain intact. Score means must agree
with the normalized distribution within .06 and repeat the requested legend.

Beaver anchors: `src/lib/chat/legalEvidence.ts`, `src/lib/tabular/extraction.ts`,
`src/lib/legalSources/index.ts` and `src/lib/llm/index.ts`. Original bytes, receipts,
source scope, permissions, mutation approval, quote checks and generative explanations
keep their existing owners. The code imports only the existing provider entry point
when the conventional baseline is explicitly selected; production never imports this
experiment. Promotion requires separately reviewed real-corpus and product evidence.

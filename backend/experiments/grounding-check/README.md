# Grounding check

One complete-answer check and a reproducible benchmark. No claim-rewriting agent,
ensemble, new service, shadow UI, or production feature flag. Production grounding
is unchanged; this directory implements and measures the candidate before wiring
it into `submit_grounded_answer`.

## What is borrowed

| Work | Reuse |
| --- | --- |
| [MiniCheck](https://arxiv.org/abs/2404.10774) | Direct pinned dependency; its Flan-T5 support model and batched inference, not a copied model implementation. |
| [ALCE](https://arxiv.org/abs/2305.14627) | Joint-evidence citation recall and individual/leave-one-out citation precision, adapted in `citation_scores`. MIT notice in [THIRD_PARTY.md](THIRD_PARTY.md). |
| [ContractNLI](https://aclanthology.org/2021.findings-emnlp.164/) | Original document-level legal entailment labels and evidence spans, with official train/dev/test splits. |
| [RAGTruth](https://aclanthology.org/2024.acl-long.585/) | Original generated answers and annotated errors, grouped by their source. Official test split remains held out. |

The papers motivate these components, not a particular production threshold.

## The entire algorithm

```text
original answer + bound source passages
       -> enumerate every original sentence (retain offsets and table text)
       -> check each sentence against its cited passages jointly
       -> accept only when every unit passes the fixed threshold
```

`check_answer` accepts multi-sentence evidence blocks; it does not rewrite them.
Every original character must belong to a checking unit. Source hashes, versions,
and half-open UTF-16 spans are checked before inference. Uncited units fail;
missing verdicts, invalid output and over-limit context never become passes.
Each answer is capped at 512 check pairs / two million combined input characters
before model dispatch; an over-limit answer is recorded as a failure, never truncated.
The answer score is the minimum unit score, not a joint probability.

The two backends are alternatives, not a cascade:

- `minicheck`: the upstream Flan-T5 model, batched over the exact document/claim
  pairs. Token preflight uses upstream's exact input format; oversized pairs
  return no verdict instead of truncating. Its max-over-chunks wrapper is not used.
- `beaver`: one bounded batched call through the existing `streamChatWithTools`
  adapter, with no tools, retries, or native subagents. Question and neighboring
  answer text are interpretation context, not evidence. It returns supported,
  unsupported, or needs-context for each unit. This also handles longer evidence.

`--citations` adds ALCE's individual/leave-one-out checks solely to calculate
citation precision. Normal checking needs only the joint-evidence pass.

## Run

Python 3.11+ and Node 22.13+. Run from this directory. Use a separate environment
for benchmark dependencies; the application's dependencies and test suite do not
change. MiniCheck downloads its model locally on first use.

```sh
python -m pip install -r requirements.txt
python benchmark.py prepare --out data
python benchmark.py run --input data/contractnli-calibration.input.jsonl --out runs/mc-cal --backend minicheck
python benchmark.py run --input data/contractnli-test.input.jsonl --out runs/mc-test --backend minicheck
python benchmark.py score --input data/contractnli-test.input.jsonl --gold data/contractnli-test.gold.jsonl --run runs/mc-test --out mc-report.json
```

`prepare` downloads the authors' original data at fixed commits and checks Git blob
hashes before importing it. It produces separate input/gold files and a manifest.
Use `--dataset contractnli` or `--dataset ragtruth` to prepare only one corpus.
ContractNLI provides document-support judgments, not generated-answer pinpoints.
RAGTruth provides natural answer errors; use only the official `quality=good`
rows, matching its baseline. RAGTruth training sources are deterministically split
80/20 into development/calibration; all answers to a source stay together. Exact
source duplicates crossing splits are rejected. Raw corpora are not committed.

For a configured Beaver flat-rate/local model, install the normal backend
Node dependencies and use its existing provider name:

```sh
python benchmark.py run --input data/contractnli-test.input.jsonl --out runs/beaver-test --backend beaver --model ollama:YOUR_MODEL --allow-live
python benchmark.py score --input data/contractnli-test.input.jsonl --gold data/contractnli-test.gold.jsonl --run runs/beaver-test --out beaver-report.json
python benchmark.py compare --left mc-report.json --right beaver-report.json
```

`codex:` and `claude-p:` are also accepted. Per-token API routes are not enabled.
Custom private packets additionally require `--allow-private` for the Beaver
backend. `--groups N --seed 17` selects N source groups per split/task, retaining
all their answers. Sampling ignores gold and input order; use the same seed and
count for both backends. The entire input is checked for split leakage before
sampling, including different versions of the same source. Each invocation
requires a fresh output directory and saves every result, raw provider response,
usage, elapsed time, code/model identity and Node/ICU segmentation versions.
An interrupted run's missing items remain in its planned denominator; there is no hidden replay or retry.

## Scoring and qualification

Reports include accuracy, missing verdicts, false reassurance among accepted
answers, unsupported-answer acceptance/detection, valid-answer retention, coverage,
source-group risk bounds, p95 time, known usage, and citation precision/recall.
Results remain split by corpus task. Failures do not earn error-detection credit.
Citation recall includes missing answers as zero. Citation precision stays unknown
when any required check is missing, with the scored-item denominator reported.
Replaying results verifies every original text range, citation binding and aggregate
score. A modified result or dropped text cannot silently improve the report.

RAGTruth's annotated error spans additionally score unit precision/recall/F1,
clean-unit retention and **error-span hit recall**: the fraction of annotated errors
overlapping a flagged unit. These are sentence-unit/overlap metrics, not word-level
F1. Rejecting a correct sentence while passing the erroneous sentence receives no
localization credit. Missing answers stay in the span denominator; unsegmented
answers and unresolved units are reported. The per-answer observations retain the
original error spans and unit scores for inspection. ContractNLI's *source* evidence
spans are never confused with RAGTruth's *answer* error spans.

`compare` accepts `--metric accuracy|valid_pass_rate|unsupported_accepted|false_reassurance|coverage|missing_rate`.
It resamples whole source groups, retaining all their rows, and reports right-minus-left
deltas for the same item-weighted rates used in `summary`. Undefined bootstrap draws
are counted; an interval is withheld if more than 5% lack the required denominator.
For example:

```sh
python benchmark.py compare --left mc-report.json --right beaver-report.json --metric unsupported_accepted
python benchmark.py compare --left mc-report.json --right beaver-report.json --metric valid_pass_rate
```

Calibrate once, then test without changing the policy:

```sh
python benchmark.py fit --input data/contractnli-calibration.input.jsonl --gold data/contractnli-calibration.gold.jsonl --run runs/mc-cal --out policy.json
python benchmark.py score --input data/contractnli-test.input.jsonl --gold data/contractnli-test.gold.jsonl --run runs/mc-test --policy policy.json --out qualified-report.json
```

Defaults require a one-sided 95% upper bound below 1% on accepted source groups
with any error and at least 95% retention of supported answers, separately in every
slice. These are configurable product targets (`--risk`, `--valid-pass`), not paper
results. Insufficient calibration data produces `enabled: false`, not a fabricated
threshold. A locked policy requires the same checker identity and disjoint test
sources/groups, including all versions of a source identity. Test data must contain
all calibrated task slices; dropping a difficult slice cannot qualify a checker.
Only completed runs qualify. `meets_policy` reports held-out results, not
calibration success.
ContractNLI's small dev/test splits alone cannot substantiate the default 1% target.

To benchmark Beaver citations, supply the same JSONL packet shape as `packet()` in
`corpus.py`: `sources`, exact `evidence`, and the original `{text,evidence_ids}`
answer blocks. Preserve real source/version identities; never substitute a gold
passage for the citation the writer actually emitted. Gold rows contain `id`,
`input_sha256` and `supported`, in a separate scorer-only file. The checker never
reads gold. To add error localization, gold may include `span_scope: "answer"` and
`spans: [{block, start, end, text}]`: exhaustive error spans using the answer block's
half-open UTF-16 offsets. An empty span list marks a supported answer. Run frozen
strict/relaxed-writer outputs separately; this PR does not change or simulate the production writer's sentence constraint.

A production change should put this check before terminal answer acceptance, using
one qualified backend and the existing repair mechanism. First establish the
held-out risk/retention targets and compare total cost/latency on actual Beaver
answers. No semantic accuracy or full research-completeness result is claimed by
these implementation checks.

## Implementation checks

```sh
python -m unittest -v
node --test bridge.test.mjs
```

They exercise actual Node segmentation/protocol, Unicode source bounds, all-text
coverage, joint citation scoring, corpus adapters, missing outputs, provider-call
bounds, exact input/gold identity, calibration separation and statistical arithmetic.
Model calls are not part of the ordinary application tests.

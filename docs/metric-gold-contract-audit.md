# Metric/gold contract audit

Date: 2026-07-26

## Outcome

No audited end-to-end benchmark currently has robust, independent gold for every correctness metric it emits or proposes. Existing results remain useful, but most are diagnostics, compatibility measurements, or agreement with a silver reference.

The enforceable contract is [`benchmarks/gold_contract/metric_gold_contract.json`](../benchmarks/gold_contract/metric_gold_contract.json). It defines 250 metric paths across 28 contracts. For every metric it records the formula, unit, authority, creation method, admissible statuses, hashes, leakage risk, scorer, failure semantics, uncertainty, interpretation, and validation required before an accuracy claim.

[`benchmarks/gold_contract/validate_contract.py`](../benchmarks/gold_contract/validate_contract.py) rejects an aggregate that:

- calls a `NOT_SCOREABLE` or descriptive metric accuracy;
- omits artifact hashes or status/sampling evidence;
- contains normalized-content duplicates or derivative-family collisions;
- does not use one least-edited upstream pstream per work family; or
- reports a `NOT_SCOREABLE` diagnostic without the literal label `NOT SCOREABLE`.

Only the root DOCX corpus scorer and its tests were hardened to enforce this contract. No nested scorer, README, master plan, or benchmark result was edited.

## Decision table

| Metric area | Current disposition | Why |
|---|---|---|
| DOCX corpus counts, deterministic coverage, reasons, timing | Descriptive only | These count system outputs; no correctness labels are involved. |
| Mike DOCX split accuracy and arm comparisons | **NOT SCOREABLE** | All 80 review rows are provisional; none has admissible accepted gold. |
| ALR split exact/tolerant accuracy | **NOT SCOREABLE as currently aggregated** | The source has 25 normalized-text duplicate rows, failure-selected sampling, unenforced human provenance, and a loader that admits unknown statuses. |
| PDF text CER/WER | Valid DOCX-reference agreement | Gold is mechanically extracted from DOCX. It is useful silver reference, not independently verified rendered-PDF truth. |
| PDF paragraph/line order | **NOT SCOREABLE** | Paragraph signatures collide and overwrite; unmatched content is excluded. Manual region/order gold is missing. |
| PDF region type/boundary/coverage | **NOT SCOREABLE** | The implemented scorer has no available region gold; current DOCX gold contains no regions. |
| PDF footnote and proposition scores | DOCX-reference agreement only | Labels and proposition boundaries are reconstructed from DOCX by benchmark heuristics. |
| PDF citation recall | **NOT SCOREABLE** | The same regex creates “gold” and predictions; occurrence precision is absent. |
| Codex calls, tokens, repair status, latency, RSS | Descriptive only | Operational telemetry does not require semantic gold; single-run timing has no variance estimate. |
| Synthetic DOCX-linking 12-case score | Synthetic contract invariant | The fixture is useful for regression, but code was tuned after a failure on that fixture and the scorer has completeness/neutrality gaps. |
| ALR smoke, hybrid replay, calls, tokens, cache, and arm deltas | Descriptive only | These measure behavior, compatibility, or projected avoided work; frozen production is not truth. |
| Supra/link/anchor accuracy | **NOT SCOREABLE** | Candidate truth is production-derived `auto`/`agent` data; URL existence is not authority or pinpoint correctness. |
| A2AJ availability, transitions, replay, and throughput | Descriptive only | These are heuristic availability or old/new/frozen-baseline comparisons, not truth comparisons. |
| ToA counts and workflow statuses | Descriptive only | These describe application output volume and routing. |
| ToA quote match, authority/link/pinpoint/retrieval accuracy | **NOT SCOREABLE** | Match scores are uncalibrated heuristics and no frozen accepted ToA gold bundle exists. |
| Locked footnote-pairing whole-set precision/recall/F1 | **NOT SCOREABLE as human accuracy** | The lock is internally consistent, but it mixes manual pages with a larger automatic-canonical source and was selected hard-examples-first. |

`NOT SCOREABLE` does not mean “do not compute.” It means the value may be shown only as a diagnostic, with that label, and cannot appear under an accuracy heading or in a composite accuracy score.

## Corpus identity: duplicates, derivatives, and pstreams

The private DOCX manifest contains 24 unique rows and no exact file-byte duplicate. That is not enough to prove independent documents. The staging code deduplicates by byte hash and prunes derivatives with filename tokens; renamed derivatives, lightly edited copies, and multiple stages of the same work can survive.

Every scored corpus manifest therefore needs these immutable fields:

| Field | Required rule |
|---|---|
| `work_family_id` | Exactly one scored row per underlying work. |
| `pstream_id` | Exactly one upstream provenance stream per work family. |
| `edition_role` | Must equal `least_edited_upstream`. |
| `source_repository` and `source_revision` | Must identify the source snapshot. |
| `content_sha256` | Must be unique. |
| `normalized_content_sha256` | Must be unique after the benchmark’s frozen normalization. |
| `selection_reason` | Must explain why this is the least-edited upstream artifact. |

Chief edits, galley edits, camera-ready files, annotated or returned copies, “clean copy” derivatives, revised outputs, and benchmark-generated PDFs cannot be independent source documents. Export/degradation profiles from one DOCX are paired conditions of one source, not additional documents.

## Gold status and provenance

An `accepted` string by itself is not proof of human gold. A scoreable semantic label must carry:

- a non-model adjudicator provenance class;
- guideline and schema versions;
- adjudication timestamp;
- source and work/pstream identity;
- immutable span/object IDs;
- canonical answer plus explicitly allowed alternatives;
- ambiguity/not-applicable state;
- first-review and adjudication records, or a documented independent audit;
- gold artifact hash; and
- a frozen train/challenge/holdout role.

The only admissible semantic status is exact `accepted` with the required provenance. `auto`, `agent`, `provisional`, `needs_review`, `rejected`, blank, and unknown statuses must not enter a denominator.

Prediction IDs and admitted gold IDs must form an exact bijection. Missing predictions must be explicit abstentions; extra and duplicate predictions are benchmark failures. This closes the current legacy-runner gap where iterating prediction rows can silently shrink a denominator.

## Scorer defects that block accuracy claims

### Split scorers

The Mike corpus scorer has the strongest status gate: it admits only exact `accepted` and currently refuses to score because none exist. Its current review queue is a deliberately balanced challenge sample, so Wilson intervals and sign-test p-values are correctly suppressed.

The ALR and legacy universal loaders exclude a short denylist rather than accepting a strict allowlist. That allows unknown, `auto`, or `agent` states to become gold. Current ALR manual split data also contains 25 repeated normalized texts. The existing 405-row aggregate must not be called accuracy until strict provenance and content-dedup gates are applied.

Several labels need care:

- ALR `char_neutral_accuracy` checks equal normalized length, not equal content.
- ALR `core_loss_gain_neutral` checks a character multiset and ignores order.
- `core_char_exact` is the order-preserving core equality invariant.
- Universal DOCX-linking `tolerant_exact` does not require character neutrality.
- Legacy under/over outcomes compare only with the canonical part count rather than the range of accepted alternatives.

### PDF order and structure

Paragraph order matches on the first 12 normalized words and stores candidate positions in a dictionary. Repeated signatures overwrite earlier positions. All order ratios then use only matched paragraphs, so omissions can raise apparent performance by disappearing from the denominator.

The proposed manual ordered-region bundle is absent locally. Current DOCX-derived gold has no `regions`, so region type, exact boundary precision/recall/F1, line coverage, pairwise line order, and exact line position are not scoreable.

### Citation, links, and pinpoints

PDF citation “gold” and candidate citations are detected by the same regex. This is shared-detector leakage, and only recall is reported.

Supra/link candidates are mostly `auto`, `agent`, or unresolved. They were derived from production/frozen context and include 513 repeated normalized footnote texts. Link validation primarily establishes that a URL exists; it does not prove that the link identifies the cited authority, correct version, or correct pinpoint. Each of those needs a separate human label.

### ToA

ToA discrepancy `match_score` is a SequenceMatcher similarity over normalized word windows. Thresholds 0.70, 0.86, and 0.995 route candidates or discrepancies; they are not calibrated probabilities or accuracy thresholds. No frozen, accepted benchmark currently establishes occurrence spans, canonical authorities, target documents, links, pinpoints, retrieved-PDF versions, or round-trip immutable text.

## Gold that can be salvaged

The ALR manual split review is potentially useful case-set gold after:

1. exact `accepted` plus human-provenance enforcement;
2. normalized-text deduplication;
3. one least-edited upstream pstream per work;
4. independent stratified re-review and recorded adjudication; and
5. a report label of “failure-selected case-set accuracy,” never population accuracy.

The locked footnote pairing set is content-addressed and has zero structural lock-validation issues. It contains 4,863 pairs over 1,458 pages. However, its selection is explicitly hard-examples-first and its provenance mixes 303 `manual_gold_locked` pages with 1,223 `gold_locked` pages; most markers originate in automatic canonical pages. Whole-set precision/recall/F1 therefore remains `NOT SCOREABLE` as human accuracy. A provenance-confirmed manual subset can become case-set gold after source/work deduplication and an independent correctness audit.

DOCX-extracted text, footnotes, and propositions are useful silver references. Reports must say “DOCX-reference agreement,” not “aggregate accuracy.”

## Minimum complete gold bundle

A single versioned bundle should join the following by immutable IDs:

```text
work family -> upstream pstream -> source document -> rendered page
             -> line/region/order
             -> footnote marker -> footnote body -> proposition span
             -> citation occurrence -> canonical authority
             -> target document/version -> pinpoint
```

Each semantic layer can then be scored only when its own accepted labels exist. Missing labels at one layer must not be borrowed from candidate output or inferred from a downstream success.

Keep two distinct evaluation sets:

- a representative, untouched holdout for population claims and uncertainty; and
- a de-duplicated challenge set for regression and failure analysis.

Do not combine their percentages. Challenge-set results are case-set results by stratum.

## Verification

Run:

```powershell
python benchmarks\gold_contract\validate_contract.py
python -m unittest discover -s benchmarks\gold_contract -p 'test_*.py' -v
```

The audit-time result was:

```text
OK: 250 metric paths across 28 contracts
Ran 3 tests
OK
```

The contract contains hashes and structural counts only for private artifacts; it does not reproduce private benchmark text.

# Gold ground-truth vetting

## Verdict

No current benchmark corpus is release-grade gold for every metric in scope.
The strongest existing assets are useful **candidate gold**, and several exact
measurements can be promoted to deterministic **oracles**, but only after their
source inputs and scorers are frozen. Everything else must be labelled
**NOT-GOLD** and excluded from headline accuracy.

The admission rule is deliberately strict:

- use one least-edited upstream pstream per work family;
- exclude chief-edited, galley-edited, corrected, exported, and other derivative
  siblings from scored gold;
- freeze source bytes, labels, normalization, and scorer code by hash;
- require identified human annotation and adjudication wherever judgment is
  involved; and
- fail closed: `auto`, `agent`, `provisional`, `needs_review`, missing, and
  unknown statuses are not gold.

No private source text was copied into this audit.

## Gold classes

| Class | Meaning | May enter headline accuracy? |
| --- | --- | --- |
| `GOLD` | Human-grounded label satisfying the complete provenance, adjudication, source, scorer, and leakage contract below | Yes |
| `ORACLE` | Mechanically decidable fact computed from frozen inputs by an independently tested, frozen scorer | Yes, reported separately from human gold |
| `CANDIDATE_GOLD` | Valuable evidence that is missing one or more required controls | No |
| `NOT_GOLD` | Synthetic smoke fixture, auto/agent label, heuristic self-label, provisional row, observational telemetry, or otherwise unsuitable record | No |

## Ranked findings

1. **P0 — Status laundering is possible.** The ALR split and supra benchmark
   loaders exclude only a small deny-list such as `needs_review` and
   `provisional`. Consequently `auto`, `agent`, unknown, and sometimes missing
   statuses can enter scoring. Beaver's DOCX loader follows the same unsafe
   pattern. Admission must instead be an allow-list containing only `GOLD` and
   metric-appropriate `ORACLE`.

2. **P0 — Human provenance and adjudication are not auditable.** The ALR split
   rows have no annotator, reviewer, adjudicator, agreement, or adjudication
   fields. Text-Fidelity's manual OCR rows contain similarly named fields, but
   all 15,834 inspected line rows leave annotator, reviewer, adjudication-note,
   and source-PDF hash fields blank while marking every row reviewed.
   Text-Fidelity's footnote verification ledger inconsistently records an agent
   or verifier and includes events without evidence files. None establishes
   independent annotation followed by documented adjudication.

3. **P0 — Citation identity, link, pinpoint, supra, and ibid labels are not
   gold.** The field corpus is explicitly provisional and primarily
   auto/agent-produced; only 285 of 423 inspected rows populate every expected
   field. The 1,690-row supra candidate corpus contains 671 `auto`, 116 `agent`,
   and 903 `needs_review` rows; its expected values are partly derived from
   production outputs and heuristics. Existing replay scoring strips URL
   fragments and validates a base destination, so it cannot establish pinpoint
   correctness. URL existence is not authority identity.

4. **P0 — Degraded-PDF “gold” is mostly a heuristic projection of the DOCX.**
   The current extractor supplies text, paragraph order, note bodies, and
   proposition passages automatically. It does not provide human-verified
   pages, regions, section/subsection hierarchy, paragraph/subparagraph
   hierarchy, or propositions. Citation recall applies substantially the same
   regex to reference and candidate, so the reference is not independent.

5. **P0 — There is no OOXML mutation/round-trip gold suite.** Existing tests
   cover a handful of synthetic XML cases and one synthetic DOCX. They do not
   freeze package-entry hashes, permitted changed parts, relationship graphs,
   field/bookmark/content-control/revision preservation, application open/save
   results, or repeat-run byte determinism.

6. **P0 — There is no Table of Authorities gold corpus.** The ToA project has
   useful unit and workflow tests, but no frozen, human-adjudicated occurrence,
   classification, grouping, pinpoint, page-reference, or rendered-output
   corpus.

7. **P1 — The ALR partition corpus is candidate gold, not release gold.** The
   inspected manual file has 423 rows: 405 accepted and 18 requiring review.
   It has 398 unique normalized note texts, so 25 rows duplicate normalized
   text. A combined 451-row derivative loses all 21 alternative acceptable
   partitions present in the manual source. Scorers do not freeze source DOCX
   hashes or scorer versions, one scorer overwrites duplicate normalized text
   in a dictionary, and splits are not held out by work family. The legacy
   runner also computes over/under-splitting against the canonical partition
   count even when an adjudicated acceptable alternative could have a different
   count.

8. **P1 — Text-Fidelity's locked footnote set is conditional evidence.** Its
   100-event verified subset is sizeable and contains 3,370 exact pairs over
   1,073 pages, but “locked” is granted by structural validation rather than
   necessarily by human verification. Nineteen verification events have no
   evidence-file reference. The inspected database also contains conflicting
   legacy waiver states, no consistent human identities, no source hashes, and
   no frozen scorer hash. Treat it as `CANDIDATE_GOLD` pending a provenance
   audit.

9. **P1 — Context-compaction results are regression smoke tests only.** Track B
   uses two synthetic sessions with 21 exact fields each and one repetition in
   each saved run. Fixture/input hashes are recorded, but the scorer code is not
   frozen, the capsule is oracle-built, and automatic capsule generation is not
   evaluated. This is a good deterministic regression fixture, not legal-state
   population gold.

10. **P1 — Token, cache, and latency values are telemetry, not accuracy gold.**
    Current runs record wall time, cache events, and provider/CLI usage. The
    token parser recursively takes maxima from CLI event fields; the results do
    not pin that parser or the event contract. A single cold or warm observation
    is not a latency benchmark. Route *choice* additionally requires an explicit
    utility policy and, where ambiguous, adjudication.

## Metric-by-metric disposition

| Metric | Existing evidence | Current class | Required ground truth |
| --- | --- | --- | --- |
| DOCX citation partition boundaries | ALR manual rows; Beaver provisional queue; 12 invented engine fixtures | `CANDIDATE_GOLD` / `NOT_GOLD` | Exact source spans; two independent legal annotations where a boundary is debatable; adjudicated acceptable alternatives; one pstream per work |
| Character conservation | Existing split scorers compare normalized character streams | Oracle-ready, not frozen | Source byte hash; explicit Unicode/whitespace/semicolon policy; independently tested scorer version and code hash; no boundary labels needed |
| Citation identity | Provisional field labels | `NOT_GOLD` | Canonical authority identifier independent of the product URL, with source evidence and human verification |
| Link correctness | URL existence and base-target replay | `NOT_GOLD` | Canonical authority target, resolver snapshot/version, expected destination, and separate link-health observation |
| Pinpoint correctness | Some extracted fragments; replay ignores URL fragments | `NOT_GOLD` | Typed locator plus exact cited span/paragraph/page in a hashed authority snapshot |
| Supra/ibid target recovery | Auto/agent candidate queue derived partly from prior outputs | `NOT_GOLD` | Target authority and target citation-part IDs, explicit ambiguity/unresolvable labels, independent adjudication |
| Deterministic OOXML mutation | Small synthetic tests | `NOT_GOLD` | Frozen package manifest, allowed mutation set, unchanged-entry hashes, semantic XML checks, deterministic replay, and application round-trip results |
| ToA detection | Unit fixtures | `NOT_GOLD` | Human-adjudicated occurrence spans, including negatives and edge cases |
| ToA classification/grouping | Unit fixtures | `NOT_GOLD` | Canonical authority IDs, citation kinds, grouping/equivalence decisions, and adjudication |
| ToA output | Workflow tests | `NOT_GOLD` | Expected rows, headings, pinpoints/page references, Word fields, and rendered/application verification |
| Degraded-PDF text/CER/WER | Auto-derived DOCX text; Text-Fidelity manual-line candidate set | `CANDIDATE_GOLD` | Human-verified reading text tied to PDF page/image and source hashes |
| Reading order | DOCX paragraph projection; candidate PageXML lines | `CANDIDATE_GOLD` | Explicit line/region order, duplicate-safe IDs, and human verification |
| Pages | Exported PDFs but no page-membership labels | `NOT_GOLD` except exact file page count | PDF hash, exporter/version/configuration, page raster hashes, and human page membership |
| Sections/subsections | No scored human labels | `NOT_GOLD` | Heading spans, levels, parent IDs, and adjudicated ambiguous headings |
| Paragraphs/subparagraphs | DOCX paragraph heuristic only | `NOT_GOLD` | Stable spans/IDs, hierarchy, continuation rules, and human verification |
| Footnotes | DOCX note extraction; conditional Text-Fidelity exact pairs | `CANDIDATE_GOLD` | Reference/body spans, label, page, pair relation, and adjudicated continuation/terminal cases |
| Proposition pairing | Sentence/passage heuristics | `NOT_GOLD` | Exact proposition spans and explicit no-proposition/ambiguous outcomes, independently annotated |
| Model routing correctness | Token-savings heuristic and arm comparisons | `NOT_GOLD` | Frozen routing policy/utility function, constraints, expected admissible routes, and adjudication for quality trade-offs |
| Token usage | Provider/CLI usage events | Oracle-ready telemetry | Raw event receipt, provider/model/version, reconciler version/hash, retry accounting, and explicit estimated-versus-billed fields |
| Cache correctness | Content-addressed cache metadata | Oracle-ready telemetry | Frozen key inputs, hit/miss reason, artifact hash, namespace/version, invalidation test, and independent trace reconciliation |
| Latency | Monotonic wall-clock observations | Telemetry only | Clock/source metadata, cold/warm isolation, randomized arm order, repeated runs, percentile/uncertainty reporting, and failure/censoring rules |
| Context-compaction legal-state fidelity | Two synthetic exact-state fixtures | `NOT_GOLD` for external claims; valid regression fixture | Licensed/adjudicated legal sessions, event ledger with supersession, source evidence, automatic compactor arm, repeated compactions, held-out families, and adversarial cases |

## Minimum gold record contract

Every scored record should carry:

```text
dataset_id, dataset_version, record_id, metric_id
gold_status: GOLD | ORACLE | CANDIDATE_GOLD | NOT_GOLD
source:
  sha256, work_family_id, pstream_id, pstream_rank
  derivative_class, upstream_provenance, source_version
label:
  schema_version, value, acceptable_alternatives
provenance:
  protocol_version, annotator_ids, independent_labels
  agreement, adjudicator_id, adjudicated_at, rationale
scorer:
  name, semantic_version, source_commit, file_sha256
  normalization_policy_id
split:
  role, group_key, frozen_at, leakage_checks
rights:
  license_or_permission, privacy_class
excluded_from_scoring, exclusion_reason
```

For an `ORACLE`, the human fields may be inapplicable, but the source and scorer
fields are mandatory. For judgment-based `GOLD`, at least two independent
labels are required; disagreements require an identified adjudicator and
rationale. Machine suggestions may be shown only after independent annotation
or must be recorded as non-independent assistance.

The scorer must reject rather than silently skip a malformed gold row. It must
also emit coverage: eligible, scored, excluded, missing prediction, duplicate,
and invalid counts. A perfect score over a selected subset must never hide
unscored gold. Record identity and duplicate checks must be recomputed from the
frozen source hash plus exact source span; a row-supplied fingerprint is
evidence, not trusted identity. Over/under-splitting must be evaluated against
all adjudicated acceptable partitions, not only the canonical partition's
length.

## Leakage and ancestry controls

1. Build a source ancestry manifest before annotation. Group all byte-identical,
   normalized-text-identical, exported, corrected, galley, chief-edited, and
   other derivative siblings under one `work_family_id`.
2. Admit exactly one least-edited upstream pstream for each family. Keep
   derivatives only in a separately reported robustness set.
3. Split by work family, publication issue/template family, and source ancestry,
   not by row. Run byte, normalized-text, citation-part, and near-duplicate
   checks across development, calibration, and holdout.
4. Keep holdout labels outside prompts, caches, generated fixtures, and tuning
   artifacts. Record every benchmark ancestor and any model-assisted label.
5. Do not use the same heuristic to create a label and score a prediction
   against it. Derived views may be tested for consistency but cannot establish
   independent correctness.

## Smallest credible build sequence

1. Change benchmark admission to an explicit `GOLD`/`ORACLE` allow-list and
   relabel all current nonconforming records `CANDIDATE_GOLD` or `NOT_GOLD`.
2. Freeze a one-pstream-per-family manifest with source hashes and group-held-out
   splits.
3. Adjudicate a deliberately small seed across every judgment metric before
   scaling: citation boundaries/identity/pinpoints/references, document
   hierarchy, footnote/proposition pairing, and ToA output.
4. Freeze and independently test the mechanical scorers for character
   conservation, OOXML preservation, usage reconciliation, cache traces, and
   clocks.
5. Backfill provenance only from primary evidence. Existing blank or
   auto-derived fields must not be mass-promoted based on filenames or status
   strings.
6. Publish versioned coverage and disagreement reports alongside scores.

## Evidence inspected

- Beaver: `benchmarks/docx_corpus/benchmark.py`,
  `benchmarks/docx_corpus/benchmark_gold.jsonl`,
  `docs/harvey-labs/design/docx-benchmark-design.md`, DOCX pilot reports, deterministic-cleanup
  tests, and context-compaction Track A/B fixtures and results.
- Legal PDF Parser: DOCX gold extraction/scoring, linking benchmark and
  synthetic fixture, model telemetry/cache code, mutation tests, and the
  degraded-PDF/model benchmark reports.
- ALR benchmark infrastructure: manual/combined/review partition corpora,
  provisional field corpus, supra candidates, split/replay scorers, and link
  truth checks. Only aggregate metadata and counts were used here.
- Text-Fidelity: footnote goldset code, SQLite verification/marker/pair metadata,
  manual OCR line bundle and manifest, and scanned-gold contract builder. Only
  aggregate metadata and counts were used here.
- ToA project: test suite and workflow documentation.

The scanned-gold contract builder in Text-Fidelity is a useful design pattern:
it hashes source artifacts and creates group-disjoint splits. No instantiated
frozen contract satisfying the complete requirements above was found, and the
underlying inspected manual labels still lack adjudication provenance.

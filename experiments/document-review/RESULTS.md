# Development results

November 9, 2026. The collection and scoring harness exist. **This is not a
validated benchmark release.** The fully authored synthetic documents remain
detectable, nine matters lack independent reference review, and there has been
no family-held-out origin test or human calibration of the quality judge.

## Materialized collection

| Matter | Level 1 | Level 2 | Level 3 |
| --- | ---: | ---: | ---: |
| Sears | 16 | 24 | 50 |
| Air Passenger Rights | 16 | 24 | 75 |
| Lynx Air | 16 | 24 | 100 |
| Federal prisons | 13 | 21 | 125 |
| First Nations child welfare | 16 | 24 | 150 |
| Chlorpyrifos | 14 | 22 | 200 |
| Waterloo encampment | 6 | 14 | 250 |
| Long-term care | 13 | 21 | 300 |
| CHL hockey | 16 | 24 | 400 |
| Canacol | 15 | 23 | 500 |

There are **2,150 Level-3 files**, not 2,150 independent source documents. Each
matter includes fifteen authored native records, three exact copies, four scan
variants and two complete-file bundles. Actual attachments are also embedded in
their transmittal files. Independent substantive versions are retained.

All **150 native records** passed checks of source/print hashes, actual attachment
bytes, email references, spreadsheet formulas/cached totals and changed version
facts. Codex visually inspected all **40 scan variants, 58 complete page images**;
their file-level decision facts remained legible. This is model visual review,
not human certification or a claim of error-free OCR. SHA-bound notes are private
at `sets/<matter>/scan-review.json`.

The focused scorer/identity tests pass: **20 tests**. They cover missing and
foreign predictions, duplicate weighting, protected-file recall, independent
uncertainty on the two designation axes, level isolation, evidence quotations,
quality caps, source-date conflicts despite model agreement, supported bundle-date
alternatives, incomplete-suite reporting, and origin metrics.
Candidate runs decide every copy and scan;
reference-only inheritance never supplies candidate answers.

## Actual origin-detection runs

Higher detector performance is worse for the synthetic-document factory.

| Arm | Inspection | Correct | AUC | Finding |
| --- | --- | ---: | ---: | --- |
| Initial metadata diagnostic | Tool-disabled metadata | 28/30 | 1.000 | Size was an origin clue. |
| Common export diagnostic | Tool-disabled metadata | 17/34 | 0.500 | Small, chance-level surface diagnostic only. |
| Initial content diagnostic | Tool-disabled text | 34/34 | 1.000 | Prose and clean/synthetic text remained obvious. |
| `native-pilot` | Filesystem agent; complete supplied images | 24/24 | 1.000 | Reused passages, identity/address mismatches and date contradictions. |
| `native-repair` | Fresh filesystem agent | 23/24 | 1.000 | Better identities/layouts, but perfectly ranked origins. |
| `full-sears` | Fresh filesystem agent; all 50 messy files | 50/50 | 1.000 | Sparse, self-contained invented story; missing operational context. |
| `source-sears` | Fresh filesystem agent; revised 50-file packet | 50/50 | 1.000 | Real public participants and transaction references did not fix repeated, explanatory prose across different writers. |
| `source-controls` | Fresh filesystem agent; 12 uniformly reprinted letters | 9/12 | 0.750 | Genuine-source inconsistencies confounded several apparent successes. |
| `source-controls-complement` | Fresh filesystem agent; opposite versions of the same 12 letters | 3/12 | 0.361 | The same genuine-source inconsistencies attracted suspicion. |

The filesystem runs used `gpt-6.1-sol`, high reasoning, Codex CLI 0.167.0 in the
isolated benchmark image. The revised Sears agent executed **23 inspection
commands**. It received anonymous PDFs, observed Legal PDF Parser text and full
page images, with no repository, recipes, gold, origin counts or source archive.
Its shell could not read auth or use the network. Packet receipts, predictions,
tool events and usage are retained under the named private `blindbox/` arms.

Sears has 30 real-origin and 20 synthetic-origin files, so its majority baseline
is 60%. Both full-packet tests had 100% balanced accuracy. Copies and embedded
families are correlated; the harness does not report an independent-document
confidence interval for those tests. The two full tests are development runs,
not held-out confirmations.

The earlier 24-file pilots also contain multiple records from shared authored
histories. Their historical per-document intervals and binomial p-values are not
independent-family estimates and are not used for acceptance. Current collection
probes explicitly suppress those statistics. Family holdouts include the entire
authored history, so changing its PDF bytes cannot make it a new held-out family.

## What the paired source experiment establishes

The source controls make a deliberately narrower test: preserve an authentic
letter's transcription, or change one registered date by one day. Both versions
are printed through the same Word/PDF pipeline. The complementary arm uses the
same source families in a separate model context, with the original/edited
assignment reversed and matched PDF metadata.

Across both arms, the detector got **12/24** decisions right. Every source pair
received the **same binary origin decision** for its original and edited version.
The mean edited-minus-original probability was **+0.0325**; the median was +0.02
(eight positive differences, three ties, one negative). Do not pool these repeated
families into 24 independent observations.

Three letters attracted suspicion in both forms because of a claim-number/year
issue, an arithmetic discrepancy, or differing proceeding identifiers that were
already in the genuine source. A confident explanation of suspicion is not proof
that the agent found our registered edit.

This supports source-conditioned, controlled alterations as a more promising
construction method. It does **not** validate wholly invented email histories,
confidential legal-advice examples, preservation of original page appearance, or
edits that change a relevance/privilege decision. Some source families overlap
the main collection; these arms are not held out.

## Reference review and scoring

For the revised Sears packet, the initial `gpt-6.1-sol` and `gpt-6-astra` reference
calls agreed on all 50 designations and dates. That agreement hid two under-specified
dates: June 7 and July 15 were clear in the page images and the existing chronology
annotations, while both reviewers accepted only month precision from poor OCR.
The initial quality judge also rejected a correct June 7 answer and treated real
candidate-OCR defects as invented claims because it saw a different transcription.
Those judgments are retained under `source-sears/text-reference-baseline`, not
treated as calibrated quality scores.

References now receive complete page images and correctly bound source
identification. Reconciliation flags a source-date conflict even when both models
agree. The quality judge receives full page images and candidate-supplied OCR as
well as the independent source transcription. Current source-based reviews remain
qualified model work, not lawyer-certified gold.

The revised reference pass used twelve source-image batches per seat, at medium
reasoning. The two reviewers agreed on all 50 relevance/privilege designations
and all ordinary-file dates. Their one bundle-date disagreement was between its
July 31 schedule and August 12 advice. Both are retained as supported component
dates. An invented date outside the supported components remains a conflict.

The Level-3 development candidate covered all 50 files and matched those
designations: designation score **100/100**, joint/family-balanced accuracy 100%,
31 relevant files, six protected files, and no protected-file release errors.
This exercises the scorer; it is not a suite-wide capability result. The
synthetic-origin failure, limited matter sample and overlapping model families
prevent that interpretation. Lower-level runs and review-entry judgments are
recorded separately when complete.

The candidate also covered Levels 1 and 2 separately, with designation scores of
100/100 for 16 and 24 files. Those levels contain no positive privilege examples.
An always-irrelevant/none baseline scores 57.89, 64.71 and 29.37 at Levels 1, 2
and 3 respectively. The stronger lower-level baseline partly reflects the
absence of positive privilege cases; report the label supports with the score.

The revised full-source Level-3 quality judge used **13 batches and all 140 page
images**, returning **98.5/100**. Its judgments mainly penalized descriptions that
omitted transmittal emails and one recoverable date. This remains an uncalibrated
model rubric assessment: whether an omitted routine cover email is material to a
concise review entry needs lawyer calibration. The earlier lower-level quality
judgments remain archived, rather than mixed with this revised method.

`development-results.json` contains current per-level results and coverage. The
suite averages are deliberately null while nine matters remain unreviewed;
one completed development matter must not be presented as a ten-matter score.

The remaining nine matters have materialized inputs but no completed independent
gold. `audit-latest.json` reports unfinished review separately from byte, scope,
nesting and transport failures. The release count remains **0/10**.

## Changes justified by the experiments

- Native authorship needs distinct writers and ordinary background detail.
  Repeating one neat factual mini-story in different stationery is detectable.
  A lawyer's original source document need not use the simple prose required of
  the model's review explanation.
- Reuse authentic structures and vary only the facts needed for a test. Preserve
  a private edit ledger and include untouched controls from those same structures.
  The date experiment demonstrates the distinction; privilege adaptations still
  need their own source/role review and blind test.
- Assess confidentiality across the whole communication family. A disclosed copy
  of advice can affect the original; the current fixture uses a confidential
  legal-team copy, with separate scheduling/business messages as controls.
- Strip transport clues across both origins. This includes XMP, ZIP/MIME markers
  on any future native-file lane, timestamps, hard-link counts, public ID/order
  seeds and exposure of lower-level membership. Current IDs/order use private
  random seeds; only the selected level may be mounted for evaluation.
- Inspect causes of detector success with paired controls. Preserve failures and
  freeze new family/template holdouts before obtaining repair feedback. More
  shuffles of an exposed development packet do not create a holdout.

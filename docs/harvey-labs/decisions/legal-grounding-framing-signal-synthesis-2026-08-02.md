# Citation-framing signal synthesis — 2026-08-02

Status: **heldout result recorded; no production detector promoted; no new
experiments run today**.

This memo is the compact handoff for the recent attempt to detect ungrounded
framing around quotations that are already known to be exact. It supersedes
none of the older experiment logs. Automatic semantic-checker verdicts remain
proxy labels, not human gold.

## Bottom line

The heldout test does not support a standalone deterministic detector based on
length. Shorter claims rank as riskier in the pooled data, but most of that
effect is the generation-arm mix: quote-only claims were both shorter and more
often rejected. Within the quote-only arm, length is essentially noise. Within
the source-context arm it is suggestive but fragile, and its useful operating
threshold reviews almost everything.

The practical recommendation is unchanged: exact quotation verification stays
deterministic; nontrivial framing around an exact quotation should be sent to
semantic checking. Cheap signals may order or prioritize review, but should not
clear a claim or serve as Beaver's grounding gate.

## What was tested

The holdout was built from the existing judicial/journal characterization
machinery, but those characterizations were used only to select exact quotes.
The selected 256 decisions were disjoint from the prior discovery graph:
targets, mutation donors, and citing decisions were excluded, including
normalized citation aliases. There were 73 journal-attested and 183
judicially-attested selections. Every quote had at least 10 lexical words.

Luna generated one quote-only and one source-context framing claim per
decision: 512 claims, eight BelowNormal workers, low effort. Opus 5 then
checked the claims blind to all deterministic features: 512 calls at eight
Idle workers. Of those, 510 were usable for scoring: 468 supported and 42
adverse; one abstained and one was invalid.

## Heldout results

Case-grouped bootstrap intervals are 95% intervals.

| Signal, fixed direction | Pooled AUC | Quote-only AUC | Source-context AUC |
| --- | ---: | ---: | ---: |
| Fewer content words | .652 [.572–.738] | .533 [.429–.633] | .664 [.461–.841] |
| Fewer frame characters | .653 [.575–.728] | .519 [.424–.609] | .650 [.445–.839] |
| Fewer total words | .630 [.546–.707] | not useful | .605 [.403–.808] |
| Lower evidence overlap | .614 [.504–.711] | .596 [.481–.708] | .653 [.451–.830] |
| More novel abstraction terms | .575 [.485–.668] | .600 [.509–.684] | .540 [.387–.687] |
| Modality upgrade | .495 | .496 | .494 |
| Frame/quote ratio | .502 | .586 | .530 |
| Operator risk, as defined | .446; inverted .554 | .467; inverted .533 | .429; inverted .571 |

The pooled length result is therefore not evidence that length measures
grounding. Quote-only claims had median length 12 and a 12.2% adverse rate;
source-context claims had median length 17 and a 4.3% adverse rate. Length can
recognize which arm produced a claim rather than whether that particular claim
is wrong.

The earlier frozen rule, content words ≤21, illustrates the operating problem:
it caught 41/42 adverse calls (97.6% recall) but flagged 429/468 supported
claims. It sent 470/510 adjudicated claims to review: a 92.2% review rate and
91.7% false-positive rate. In source-context alone it still reviewed 84.8% of
claims for 90.9% recall. Lower evidence overlap was somewhat more efficient at
the same observed recall, but at 95% recall it also reviewed about 94% of the
source-context arm.

## Operational readout

- Do not promote length to a grounding gate. It is a plausible queue-priority
  feature, but its apparent lift is confounded by claim style and judge/source
  mix, and its high-recall threshold reviews nearly everything.
- Keep evidence overlap as a cheap secondary priority feature. It has the most
  credible direction among the tested lexical signals, but still is not an
  efficient detector at the recall legal work requires.
- Treat semantic checking as the actual decision step for nontrivial framing.
  Deterministic signals should order or widen that review, never clear a claim.
- The best next deterministic hypothesis is quote-role/status mismatch: a
  party argument becoming a holding, “may” becoming “must”, a reported fact
  becoming an established fact, or one legal doctrine becoming another.

The semantic scores are provisional evaluation labels, not truth. They are
useful for ranking hypotheses and finding examples, but the conclusion should
not be stronger than the checker's calibration.

## Hypotheses to carry forward

1. **Length is a prioritization feature, not a detector.** It may correlate
   with terseness and with missing attribution, but the current evidence does
   not separate that from generation-arm and judge behavior. Do not use the
   ≤21-word rule as a cost-saving gate.

2. **Evidence overlap is the best remaining cheap candidate, but only a weak
   one.** Its direction survived both arms and the manual sensitivity check
   better than length. It still does not achieve a useful high-recall operating
   point without reviewing most claims.

3. **The likely first-rate deterministic signal is quote-role/status mismatch.**
   The recurring substantive errors are not random lexical novelty. They are
   promotions of a quote from one status to another: party submission → court
   holding; reported symptom → established fact; rejected argument → governing
   rule; statute/reference title → proposition; “may” → “must”; litigation
   privilege → solicitor-client privilege. A future shared, corpus-tested
   signal should identify these source roles from the local decision context
   and compare them with the generated framing.

## Reuse as a benchmark

This run already provides a benchmark seed. The reusable unit is not the
semantic-checker receipt; it is a structured example containing:

- the decision identifier and split, citation/source metadata, exact quote, and
  local source context;
- a generated framing claim, with its generation arm (quote-only or
  source-context);
- deterministic features such as content length, evidence overlap, modality,
  novelty, and operator risk;
- a semantic-checker verdict marked explicitly as a proxy label.

The existing tools form a small benchmark pipeline:

1. legal-grounding-quote-framing-benchmark.ts selects decision-disjoint quotes
   and emits the frozen item manifest.
2. legal-grounding-natural-framing.ts generates claims against that manifest.
3. legal-grounding-semantic-benchmark.ts records an independent proxy score.
4. legal-grounding-semantic-analysis.ts produces feature rankings and
   operating-point tables.

To make this seed durable, freeze the manifest and hashes, split by decision
(and, where possible, citation family), add explicit role/status fields, and
keep generated claims and scores as separate receipt layers. That supports
three cheap, repeatable uses without re-adjudicating the whole corpus:
compare detectors on a fixed holdout, test whether a signal survives a new
generation model or citator, and sample only disagreement or short-tail strata
for calibration. A future gold subset should be small and independently
checked; the full proxy-labelled set is a development and stress-test suite.

## Next honest test, not run today

Treat this holdout as development evidence for the role/status hypothesis.
Pre-register the role categories, the direction of evidence-overlap risk, and
the handling of length before constructing a second decision-disjoint,
source-context-only holdout. Use journal and judicial descriptions to diversify
quote selection, not as the whole label source. Keep the existing semantic
checker as the primary proxy and audit its short-tail behavior explicitly.

The test passes only if a deterministic signal retains useful recall after
conditioning on generation arm and survives removal of a few obvious judge
false positives. Otherwise the product should simply route framing claims to
semantic checking and use deterministic features only for queue ordering.

## Receipts

- Holdout rows: `experiments/legal_grounding_framing/receipts/natural-qf-holdout-rows-v1.jsonl`, SHA-256
  `a39ed51d3c09f3fe26ba9447ae83dbad12547b303daff3165178939d6edf8de8`.
- Luna generations: `experiments/legal_grounding_framing/receipts/natural-qf-holdout-luna-512-v1.jsonl`, SHA-256
  `5e6611ad09e4dafa8833c5678f580bd7a712e97382f141a0001026a8c4e61e2c`.
- Opus receipts: `experiments/legal_grounding_framing/receipts/natural-qf-holdout-opus5-512-v1.jsonl`, SHA-256
  `e5d7e8f318761b9f24e672d40f0d3f7178a29fcbf46cfc3f7e4e18e088cfdf14`.
- Frozen score: `experiments/legal_grounding_framing/receipts/natural-qf-holdout-opus5-score-frozen-v1.json`, SHA-256
  `37d6bbe85d0a5bc16ac8a4cf638ffca5a7c2e6601db134b19f82c3fc199b7382`.

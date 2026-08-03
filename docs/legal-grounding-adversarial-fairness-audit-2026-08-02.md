# Adversarial fairness audit of the citation-grounding evaluation

This is an attack on the evaluation setup, not a claim about model quality.
The question is: what could make a cheap signal look good, make an arm look
better, or make a benchmark conclusion look more general than it is?

## Findings

### Confirmed: the constructed CSLB negatives are not all guaranteed negatives

The same-class passage donor, concatenated clause, and swapped citation may
still support the target by coincidence. “Different passage” is not the same
as “unsupported.” The current labels are valid mutation labels, but they are
not oracle judgments of legal support. The qualifier mutation is safer, but
its fixed sentence is also an obvious template cue.

Consequence: a detector can learn mutation artifacts or donor dissimilarity.
Repair: score each mutation separately; reject donor pairs with high lexical
or citation overlap; hold out mutation templates; and add minimally edited,
human-free counterfactuals whose only changed fact is the support relation.

### Confirmed: live signal labels are endogenous checker behavior

The live scanner labels a cell positive when the holistic checker rejects it.
That measures “predicts this checker’s rejection,” not “detects an ungrounded
citation.” A signal can therefore win by modeling checker prompts, schema
strictness, or the same lexical lint already used by the checker.

Repair: keep checker prediction explicitly named as a proxy endpoint; require
the constructed CSLB endpoint and an external or judicially sourced endpoint
before promoting a grounding claim.

### Confirmed: the live scanner has a signal-accounting defect

For every conclusion it first pushes all post-length lint values, including
`scope_mismatch`, `qualification_drift`, and `evidence_overlap`, and then
pushes those three values again from their custom implementations. Max pooling
usually hides this because the duplicate zero does not win, but it is still a
silent measurement defect and would break if a feature’s range changed.

Repair: each signal must be appended exactly once, with a self-test asserting
one value per conclusion per signal.

### Confirmed: current live composition comparisons are not pure detector tests

`attested_framing` can invoke citator/profile machinery and rank-policy paths
that `quote_first` does not. It also changes the prompt and tool trajectory.
The observed F1/pass deltas are therefore composition results, not evidence
that the journal or alienness signal improved grounding.

Repair: report each arm as a workflow treatment; for signal ablations, freeze
the generated answer, evidence, checker, and receipt, then score only the
deterministic signals.

### Confirmed: the metric is vulnerable to valid-paraphrase and length bias

Target-token F1 rewards lexical overlap with the benchmark target and can
penalize a legally faithful paraphrase. Length-adjusted AUC helps with one
confound but does not solve semantic equivalence or citation relation.
Pass/support gates are contract outcomes, not legal correctness.

Repair: retain token F1 as a diagnostic, but add source-span entailment or
structured support-unit scoring, exact citation/pinpoint validity, and
paired mutation accuracy. Always report length and target overlap separately.

### Confirmed: synthetic families can leak into the signal

Every case produces one positive and several related negatives. The fixed
qualifier sentence, appended donor target, and repeated parent claim make the
negative class structurally recognizable. A random row split would be badly
optimistic; the current document grouping is safer, but it still leaves
mutation-family and benchmark-template leakage.

Repair: split by source document and mutation family; include unseen mutation
templates in test; use paired bootstrap intervals for within-document
comparisons.

### Confirmed: benchmark selection is narrow and order-dependent

`cslbCases` takes the first `perSource` rows for each category. This is not a
random or court/area-balanced sample. The recent live batches cover only 30
CSLB cases per split, while the CLERC/Housing smoke has one CLERC and two
HousingQA cases. Those runs can validate plumbing, not broad performance.

Repair: freeze a hash-seeded, stratified manifest by source document, court,
area, adversarial status, and target length; publish the manifest counts.

### Confirmed: conclusion-only max pooling changes the estimand

The live signal scan drops cells without conclusions from the main signal
analysis and max-pools all conclusions within each surviving cell. Cells with
more claims get more chances to produce an extreme value. Missing conclusions
are reported separately, but not integrated into the primary detector metric.

Repair: pre-register cell-level, claim-level, mean-pooled, and max-pooled
estimands; treat missing conclusions as an explicit protocol outcome; use
document-grouped bootstrap for all of them.

### Risk: judge/court/reference profiles can encode topic and court mix

A judge profile may appear useful because a judge handles a distinctive area
of law, writes longer opinions, or sits in a court with a distinctive format.
Court alienness may simply be a proxy for province, reporter, period, or
document length. Exact-name matching can also make easy cases “missing” and
leave a selected subset with unusually rich authorship metadata.

Repair: report coverage and reference counts; compare judge-only, court-only,
decision-only, province-only, and matched-length/topic controls; keep ambiguous
identity missing; split profiles by time and exclude the target decision.

### Risk: journal positives are strong provenance, but not a universal support
gold standard

Editorially published law-review footnote pairs are meaningful positive
evidence and should be treated much more seriously than arbitrary text. They
still inherit pairing/parser errors, can describe a case critically, and do
not guarantee that every later claim is entailed by the cited authority.
The correct label is “editorially attested characterization,” not automatic
case-law entailment.

Repair: preserve this as a high-value provenance stratum; separately test
whether the proposition/citation relation is exact, qualified, critical, or
merely topical.

## Priority repair order

1. Fix the duplicate signal accounting and add invariant tests.
2. Re-score existing receipts with frozen, deterministic features only.
3. Report mutation-specific paired results and unseen-template results.
4. Replace first-N benchmark selection with a frozen stratified manifest.
5. Add an external/judicial endpoint before making grounding claims.
6. Then run judge/court/decision profiles with coverage and matched controls.

Until these are done, the strongest defensible claims are that generic
alienness and reversed evidence overlap predict some current checker behavior,
and that the journal lane provides a credible, high-value provenance source.
Neither is yet a general citation-grounding detector result.

## Implementation note

The live receipt scanner now keeps `checker_holistic_proxy` as explicit label
provenance, records judicial-characterization overlap,
journal-characterization overlap, and their convergence as separate signals,
and fixes the prior duplicate insertion of custom signals. These features are
still lexical diagnostics; they are not promoted to independent grounding
labels.

## Harness results

The reusable CSLB constructor now supports `--split all`, producing one
dev/test JSONL artifact. A 24-case smoke produced 96 rows (24 constructed
positives and 72 controlled negatives). On its held-out constructed split,
qualification drift was the only solo feature above chance (AUC 0.626;
grouped bootstrap 95% interval 0.552–0.735). The frozen multi-signal arm
reached AUC 0.755 (0.664–0.887). These numbers describe the constructed
mutations, not real-world hallucination prevalence.

The live scanner now emits row-level matrices and SHA-256 manifests. Scanning
the earlier 300-cell Luna receipts yielded 240 conclusion cells and 42
checker-rejected cells, all explicitly labelled `checker_holistic_proxy`.
Judicial-characterization overlap had raw rejection AUC 0.405; journal overlap
0.489; convergence 0.489. After reversal, these are at most weak support
signals, not evidence of a useful hallucination detector. Coverage and source
selection remain important confounds.

Reusable commands:

```text
tsx backend/scripts/legal-grounding-honest-benchmark.ts --prepare-cslb <a2aj_benchmark.jsonl> --split all --out <constructed.jsonl>
tsx backend/scripts/legal-grounding-honest-benchmark.ts --score <constructed.jsonl> --train-split dev --eval-split test
tsx backend/scripts/legal-grounding-live-signal-scan.ts --files <receipt1>,<receipt2> --matrix-out <matrix.jsonl> --manifest-out <manifest.json>
```

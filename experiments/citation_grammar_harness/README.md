# Citation grammar harness

This experiment measures Beaver's authored case-citation grammar against the
provider-curated `cases_cited_en/fr` arrays in the locally installed A2AJ
Parquet snapshot. It resolves the snapshot through `OpenLegalData`, accounts
for every manifest shard, uses exact original-text spans, and uses A2AJ plus
CanLII exact citation indexes only to verify candidate matches outside the
document's curated citation list.

The split is frozen as `sha256-v1`: SHA-256 of language plus the provider
citation; buckets divisible by five are held out. A candidate never edits the
authored corpus directly. It is a small overlay with this shape:

```json
{
  "format": "beaver.citation-grammar-candidate.v1",
  "name": "measured-dialect-name",
  "entries": [{ "id": "cite.neutral.example", "pattern": "...", "flags": "", "canonical": {}, "provenance": "...", "vectors": [] }]
}
```

Every candidate entry needs at least one positive and one adversarial-negative
vector. The harness rejects candidates without a strict held-out recall gain,
with an unresolved new match, with more than 10% aggregate runtime regression,
or with an input over the wall cap.

Fast baseline:

```powershell
python experiments/citation_grammar_harness/run.py --tier smoke
```

Promotion-grade comparison (hashes every corpus and oracle file):

```powershell
python experiments/citation_grammar_harness/run.py --tier full --candidate experiments/citation_grammar_harness/candidates/example.json
```

Runs checkpoint after every dataset/language under ignored `results/`. A rerun
resumes only when every scorer, grammar, corpus, oracle, split, and option
fingerprint matches; stale checkpoints fail closed.

Self-test:

```powershell
python -m unittest experiments/citation_grammar_harness/test_run.py
```

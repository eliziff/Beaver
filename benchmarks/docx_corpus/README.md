# Local DOCX corpus benchmark

This is the corpus-scale layer missing from the existing
`legal-pdf-parser` split/link benchmark. It reuses that engine; it
does not copy or import the ALR application at runtime.

Run the two local deterministic arms over the private corpus:

```powershell
python benchmarks\docx_corpus\benchmark.py scan `
  --manifest benchmarks\docx_corpus\private_manifest.jsonl `
  --output-dir benchmarks\docx_corpus\private_results\local
```

Create a stable, document-diverse provisional review sample:

```powershell
python benchmarks\docx_corpus\benchmark.py sample `
  --cases benchmarks\docx_corpus\private_results\local\cases.private.jsonl `
  --output benchmarks\docx_corpus\private_results\gold.review.jsonl `
  --sample-size 80
```

Every row starts as `provisional`. A human must fill
`expected_verbatim_parts`, add only genuinely equivalent
`acceptable_partitions`, and change the status to `accepted`.
The 40/40 eligible/abstention balance makes this a challenge set, not a
representative estimate of corpus accuracy. The command refuses to overwrite
existing review work unless `--force` is supplied.

Score local arms and make a paired comparison:

```powershell
python benchmarks\docx_corpus\benchmark.py score `
  --gold benchmarks\docx_corpus\private_results\gold.review.jsonl `
  --prediction conservative=benchmarks\docx_corpus\private_results\local\predictions.deterministic_conservative.jsonl `
  --prediction recall=benchmarks\docx_corpus\private_results\local\predictions.deterministic_recall_first.jsonl `
  --baseline conservative `
  --output benchmarks\docx_corpus\private_results\local\score.json
```

For live model arms, first freeze accepted rows into the fixture format already
supported by the Legal PDF Parser:

```powershell
python benchmarks\docx_corpus\benchmark.py fixture `
  --gold benchmarks\docx_corpus\private_results\gold.review.jsonl `
  --output benchmarks\docx_corpus\private_results\live-fixture.json `
  --frozen-gold benchmarks\docx_corpus\private_results\live-gold.jsonl

python legal-pdf-parser\dev\benchmark_docx_linking.py `
  --fixture benchmarks\docx_corpus\private_results\live-fixture.json `
  --output benchmarks\docx_corpus\private_results\live-results.jsonl `
  --arm gpt-5.6-sol:hybrid --effort max
```

That last command sends the selected footnotes and proposition passages to the
configured model provider. Keep the corpus, gold, fixtures, model traces, and
results under the ignored `private_*` paths.

Score deterministic arms against `live-gold.jsonl` when comparing them with
the live fixture so every arm uses the same frozen case IDs. Confidence
intervals and p-values are suppressed for the balanced challenge design.

Small runnable check:

```powershell
python benchmarks\docx_corpus\benchmark.py self-test
```

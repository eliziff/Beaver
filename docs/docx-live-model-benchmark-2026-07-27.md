# DOCX citation-intent model benchmark — 2026-07-27

## Status

The canonical 12-case benchmark is frozen and reproducible, but the six legal-data
model arms were **not run**. The external-execution approval gate rejected sending
the selected private footnotes and propositions to OpenAI through the Codex CLI.
No model score, benchmark latency, or benchmark token count is therefore reported.

All three requested model identifiers were separately capability-probed at low
effort with the non-sensitive prompt `Reply with exactly OK.`. Each route was
supported and returned `OK`; these probes are not benchmark results.

| Model | Capability probe | Approx. wall time | Input / cached / output tokens |
| --- | ---: | ---: | ---: |
| `gpt-5.6-luna` | supported | 5.4 s | 15,091 / 8,960 / 5 |
| `gpt-5.6-terra` | supported | 7.1 s | 16,514 / 6,912 / 5 |
| `gpt-5.6-sol` | supported | 6.5 s | 18,709 / 0 / 5 |

## Canonical corpus and frozen sample

- Upstream corpus SHA-256:
  `9222572d2a48d9e1a115d6fc305fe79ea4498f99de4a624700b86b594e15a43e`
- Frozen manual-gold SHA-256:
  `95e8b9b9175499318d3b3a9f8329b5927e8cc8f9730045bd6d92ccb0bdf446c0`
- Corpus footnotes: 204.
- Accepted frozen-gold records: 387.
- Exact accepted-gold matches in the upstream corpus: 70, exceeding the
  pre-run gate of eight.
- Selector: `sample-size=12`, seed `docx-linking-v1`.
- Frozen gold IDs:
  `manual-0341`, `manual-0413`, `manual-0294`, `manual-0290`,
  `manual-0324`, `manual-0333`, `manual-0366`, `manual-0410`,
  `manual-0331`, `manual-0330`, `manual-0337`, `manual-0400`.
- Sample size: 3,050 characters across 12 footnotes; median 151.5,
  range 52–816.
- Gold partitions: 27 total; median 1.5 per footnote, range 1–7.

This is one least-edited upstream document. No chief-edited, galley,
camera-ready, or Table-of-Authorities derivative is included.

## Offline baseline

The deterministic splitter safely handled 1 of 12 cases and matched its frozen
gold partition exactly, with character-neutral coverage. Eleven cases require
the bounded model worker.

| Measure | Direct | Hybrid |
| --- | ---: | ---: |
| Model-bound cases | 12 | 11 |
| Estimated tokens | 16,413 | 16,201 |
| Estimated saving | — | 212 |

The current router recommends `direct`: the estimated hybrid saving is below
its 512-token threshold. The requested forced `hybrid` arms remain useful to
test whether deterministic pre-splitting changes accuracy or observed cost.

## Requested arms

| Model | Strategy | Result |
| --- | --- | --- |
| `gpt-5.6-luna` | direct | blocked before canonical external call; no score |
| `gpt-5.6-luna` | hybrid | blocked before canonical external call; no score |
| `gpt-5.6-terra` | direct | blocked before canonical external call; no score |
| `gpt-5.6-terra` | hybrid | blocked before canonical external call; no score |
| `gpt-5.6-sol` | direct | blocked before canonical external call; no score |
| `gpt-5.6-sol` | hybrid | blocked before canonical external call; no score |

Exact prepared command:

```powershell
python dev\benchmark_docx_linking.py `
  --docx _temp\docx_corpus_live\corpus-9222572d2a48.docx `
  --gold _temp\docx_corpus_live\gold-95e8b9b91754.jsonl `
  --output _temp\docx_corpus_live\canonical\results.jsonl `
  --sample-size 12 `
  --seed docx-linking-v1 `
  --effort low `
  --timeout-seconds 900 `
  --arm gpt-5.6-luna:direct `
  --arm gpt-5.6-luna:hybrid `
  --arm gpt-5.6-terra:direct `
  --arm gpt-5.6-terra:hybrid `
  --arm gpt-5.6-sol:direct `
  --arm gpt-5.6-sol:hybrid
```

## Noncanonical interrupted run

An earlier run used an edited derivative and is excluded. Three attempted arms
(`luna/direct`, `luna/hybrid`, and `terra/direct`) each failed in the restricted
sandbox with a socket-permission transport error before producing a response,
score, or token telemetry. That copied derivative was removed from the corpus.
The partial raw logs and cache remain quarantined under the ignored
`_temp/docx_corpus_live/noncanonical-edited-*` paths for audit only.

## Privacy and limitations

The canonical corpus, frozen gold copy, capability outputs, model cache, and raw
results live only under the repository-ignored
`universal-legal-pdf-engine/_temp/docx_corpus_live/`. This tracked report contains
no document text.

Running the prepared command requires explicit approval to transmit the selected
12 private legal footnotes and their paired propositions to OpenAI through the
Codex CLI. Until that approval is granted, any accuracy, comparative latency,
or token-cost conclusion would be fabricated. Even after approval, this is a
small one-document sample and should be followed by a multi-document upstream
corpus with separately frozen manual gold.

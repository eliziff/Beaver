# Legal grounding framing experiment

This directory contains the reusable, experimental harness for testing cheap
signals on framing around quotations that have already passed exact-quote
verification. It is not production wiring.

The four TypeScript entrypoints are deliberately kept with the experiment:

- `legal-grounding-quote-framing-benchmark.ts` — deterministic selection,
  construction, scoring, and decision-disjoint holdout preparation;
- `legal-grounding-natural-framing.ts` — Luna claim generation;
- `legal-grounding-semantic-benchmark.ts` — independent semantic checking;
- `legal-grounding-semantic-analysis.ts` — proxy-verdict signal analysis.

Run them from `backend` so the normal backend environment and dependencies are
loaded, for example:

```powershell
$env:NODE_PATH = (Resolve-Path '.\node_modules').Path
npx tsx ../experiments/legal_grounding_framing/legal-grounding-quote-framing-benchmark.ts --self-test
```

The local selection caches, prompts/results, and score receipts live under
`receipts/`. That directory is intentionally ignored: model traces and local
corpora are evidence for the experiment, not repository source. The durable
findings and the next hypothesis are recorded in
`docs/legal-grounding-framing-signal-synthesis-2026-08-02.md`.

# Jev attribution experiment

Tests whether TypeSafe's Jev (System One decision model) can be adapted to the
repository's opinion-boundary and quote-attribution benchmarks, and measures it
there. It uses the frozen benchmark selections and the local A2AJ source text,
but it is otherwise standalone.

## What it does not do

- It never invokes Codex and does not use the retired subscription runner.
- It never calls the Codex-authored semantic judge. Semantic attribution and
  treatment judgments are the main agent's own reading of the source, frozen in
  `attribution-spec.json` and `treatment-spec.json` before the calls ran.
- It does not edit the existing benchmarks, gold files, or `backend/` code.
- Opinion boundaries are scored by the existing mechanical comparator
  (`compareDecisionStructure`), not by a model.

## Adaptation

Jev takes `state` plus a map of typed `questions` (Choice, Score, Noul) and is
designed for atomic, well-scoped questions evaluated in parallel. The benchmark
contracts are not request shapes, so each stage re-encodes one:

- **boundaries** — the document is line-tagged (`L039| [1] ...`). One Choice
  question per boundary point ranks all line ids (the documented 255-option
  line-id pattern), plus a Choice opinion count and a Noul multi-opinion check.
  Speculative `start_N`/`end_N` questions are truncated in code by the reported
  count.
- **attribution** — five atomic questions per frozen passage: whose words they
  are, whose proposition it is, whether it is a verbatim quotation, whether a
  party advanced it, and whether the court endorses it. Separate opinion-
  relationship items ask whether a passage is a separate opinion, whether its
  author sat on the deciding court, and whether it agrees with the lead
  disposition versus the lead reasoning.
- **treatment** — the retired fine-grained vocabulary (target identity, legal
  actor, reduced treatment label) applied to fixed target occurrences.

## Run

Requires `TYPESAFE_API_KEY` and the installed A2AJ provider database.

```powershell
.\backend\node_modules\.bin\tsx.cmd experiments/jev-attribution/export_boundaries.ts
python experiments/jev-attribution/run_live.py boundaries --tag run2
python experiments/jev-attribution/run_live.py attribution
python experiments/jev-attribution/run_live.py treatment
.\backend\node_modules\.bin\tsx.cmd experiments/jev-attribution/score_boundaries.ts run2
```

`receipts/` holds raw requests, raw responses, and per-item judgment; it is
ignored. See [RESULTS.md](RESULTS.md) for measured outcomes.

# Citation units A/B

How a read numbers a source and a citation names a passage, set by `BEAVER_CITATION_UNITS`:

- `json` — passages as JSON objects with digest `evidence_id`s (the earlier behaviour);
- `lines` — numbered lines under each source's key, cited as `key#L12` or `key#L12-L14`;
- `sentences` (default) — the same with every sentence its own numbered line.

`run.mjs` starts the built backend (`backend/dist`) once per arm, each in its own process and data directory, and asks
every arm the questions in `questions.json` over its chat API as the app asks them (default model
`codex:gpt-6-luna` at `max`). Claims and the passages they cite are read from each arm's own database, tokens from its
`MIKE_LLM_METRICS_PATH` file, and a judge model (`codex:gpt-6.1-sol`, `medium`) reads each claim against the text it
cites. All inference uses Codex subscription routes. Build the backend first, then from the repository root:

```powershell
node experiments/citation_units_ab/run.mjs
node experiments/citation_units_ab/run.mjs --only moazzen,mcdonald --repeat 2
node experiments/citation_units_ab/run.mjs --judge experiments/citation_units_ab/receipts/<run>
```

The last form judges and summarizes a finished run's turns again without asking the questions.

Each run writes `receipts/<time>/` (ignored by git): `turns.jsonl` as turns finish, `results.json` with verdicts,
`summary.md`, and each arm's server log, metrics and data.

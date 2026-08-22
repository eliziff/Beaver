# Text fragment fidelity — 1000-decision corpus experiment

Prove that Beaver's pinpoint-link builder produces text fragments that land
on live publisher pages, at corpus scale, using **flattened A2AJ text only**.
No production changes happen inside this experiment; proven findings are
promoted later as ordinary commits to `backend/src/lib/legalSourceLinks.ts`
plus its tests.

## Method

Black-box gate per seed: load the built URL in real Chrome (mobile UA),
wait for navigation to settle, then measure two things:

- did `::target-text` actually paint? (screenshot pixel analysis - Chrome
  does not expose fragment matches via `getSelection()`)
- where did the page scroll?

Placement correctness for any non-clean case is judged by reading the saved
screenshot. The harness never queries publisher DOM structure: the builder
under test cannot see it either, so the verifier must not use information
the builder could not have.

## Pipeline stages (all idempotent)

1. `coverage` - snapshot dataset list once (`results/coverage.json`).
2. `harvest.mjs` - stratified sample of **1000 decisions** across all A2AJ
   datasets (floor per dataset + log-weighted share). Writes
   `results/manifest.jsonl` (one row per decision, pinned citation/url/
   status) and `results/seeds.jsonl` (2 receipts per decision: one
   short-exact, one authority-cluster window when present, else long-range).
   Deterministic: per-citation RNG, fixed queries, stable labels. Resume =
   re-run; completed decisions are skipped via the manifest.
3. `gate.mjs` - sequential, polite (~1.5s between loads), resumable via
   `--results` JSONL keyed by label; screenshots under `results/shots/`.
4. `aggregate.mjs` - verdict breakdowns by provider host / shape / dataset;
   failure screenshots listed for manual reading.

Raw outputs stay under `results/` (gitignored). Durable conclusions go to
`RESULTS.md`.

## Promotion criteria

A spelling/projection rule may move into production only when:

- every failure class it addresses is demonstrated on real captured pages,
- the full corpus gate shows no regression on previously-matched seeds, and
- backend unit tests cover the rule against fixture documents mirroring the
  captured markup.

Candidate builder work lives in `patches/` and experiment-local fixtures
until promoted.

## Known provider-data limits

Some A2AJ datasets (e.g. RPD) expose anonymized decisions as bare `.txt`
artifacts with no public publisher page; those records are skipped with
`status: "no-public-url"`. Production already degrades safely for such
receipts (`sourceUrl()` returns null), so there is nothing to gate against.

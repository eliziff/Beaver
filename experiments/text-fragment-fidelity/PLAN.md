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

## Design principle: reliability over coverage

The north star is a highlight that paints reliably. It is acceptable to drop
small, fragile stretches - leading paragraph markers (`[63]`), leading
pinpoints after a seam (`s. 1`, `para. 33`), detached punctuation at an edge -
rather than emit spellings that may fail. A clean match that omits a tiny
edge beats a complete span that does not paint. Strategies already honour
this: leading-label stripping, seam tails that drop the opening pinpoint, and
seam heads truncated at the punctuation.

## Pipeline stages (all idempotent)

1. `coverage` - snapshot dataset list once (`results/coverage.json`).
2. `harvest.mjs` - stratified sample of **1000 decisions** across all A2AJ
   datasets (floor per dataset + log-weighted share). Writes
   `results/manifest.jsonl` (one row per decision, pinned citation/url/
   status) and `results/seeds.jsonl` (2 receipts per decision: one
   short-exact, one authority-cluster window when present, else long-range).
   Deterministic: per-citation RNG, fixed queries, stable labels. Resume =
   re-run; completed decisions are skipped via the manifest.
3. `gate.mjs` - sequential, polite (~0.9s between loads), resumable via
   `--results` JSONL keyed by label; screenshots under `results/shots/`.
4. `aggregate.mjs` - verdict breakdowns by provider host / shape / dataset;
   failure screenshots listed for manual reading.

## Replay tier (fast iteration loop)

Live gating is ~30 min/cycle even parallelized. The replay tier cuts the
loop to minutes:

- `crawl-pages.mjs` - one-time parallel crawl caching each unique page's
  HTML under `results/page-html/` (manifest: `page-html-manifest.jsonl`).
  Decisia hosts are fetched with the load-bearing
  `iframe=true&site_preference=mobile` parameters and a 4s post-load settle,
  because they inject the decision text after load (caching early shells
  was the first replay bug).
- `gate-replay.mjs` - same verdicts/placement as `gate.mjs`, but pages are
  served locally through route interception; no publisher traffic, no
  politeness pause, 6 workers, 200ms settle. Full corpus in minutes.
  `--builder production|candidate` selects the builder under test.
  Placement uses a text-node walk with ancestor climb (layout-forcing
  innerText only on candidate blocks).
- `calibrate.mjs` - certifies replay fidelity: replay-production verdicts
  are diffed against collected live results (builder held constant), and
  replay-candidate placement against live placement where available.
- `make-cached-subset.mjs` - seeds whose pages are cached so far; allows
  replay testing mid-crawl.
- `purge-decisia-cache.mjs` - drops Decisia-family cache entries for
  re-crawl after capture bugs.

Known dead end: same-document `location.hash` navigation does NOT process
`:~:text=` fragments (Chrome strips the directive), so each seed still
needs a real navigation; per-document reuse is impossible.

Live Chrome remains for calibration drift checks and promotion acceptance;
strategy iteration happens in replay.

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

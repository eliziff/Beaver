# Results

## 2026-09-15 — harness validation, no live quality result

Base reviewed: Beaver `25e59c113339e4fa0d44b11ff980c3639895b9c6`.
Implementation: three read-only frozen-packet benchmarks, direct Jev HTTP adapter,
optional existing Beaver-provider control, separated gold/scoring, calibration and
paired group-bootstrap comparisons. No production or production-test changes.

Validation actually run in an isolated added-files workspace, Node v22.16.0/Linux:

```sh
node --test backend/experiments/jev-decisions/harness.test.mjs
node backend/experiments/jev-decisions/cli.mjs smoke --out /mnt/data/jev-smoke-final
```

All 13 focused checks passed (approximately 0.5 seconds for the test process).
Coverage includes real loopback HTTP for all three task paths, typed response
validation, exact source/receipt binding, closed input contracts, split leakage,
budget exhaustion, no hidden retries, interrupted-call handling, resume/lock
conflicts, timeout/cancellation, wrong-evidence scoring, partial-scope not_found,
No versus absence, ranking/pooled recall, calibration refusal and paired group
resampling. The conventional-provider call contract was checked with an injected
provider boundary; its actual runtime was not invoked.

The CLI smoke completed nine invented fixture requests and eleven observations
(five claim decisions, four categorical cells, two search queries). Those responses
are deliberately generated from fixture expectations to check protocol/scoring.
They are not Jev predictions, independent annotations or legal accuracy evidence.
No API keys were used and no metered, flat-rate or local model calls were made.

Not run: live TypeSafe API, configured Beaver provider, native/source corpus gates,
full backend/frontend suites, browser/Word integration, or real human-adjudicated
legal-corpus inference. The container could not resolve GitHub for a normal clone;
repository context came through the GitHub connector and validation was scoped to
the added files, not a claimed full restored checkout. Full-sweep authorization
was neither requested nor assumed.

Retain this as experiment infrastructure. A real model comparison must freeze
independent source/topic groups, adjudicate separate gold, retain failures and
actual usage, and report held-out quality before any production proposal. The
first implementation does not execute downstream repairs, full-row explanations,
corpus retrieval, treatment-omission discovery or product fallback workflows.

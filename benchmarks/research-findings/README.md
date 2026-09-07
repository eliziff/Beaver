# Research findings: operation-scoped reads

Baseline: `6852d6d4f353c4ec53f11ace3cdba5a5f2d0b1c6`.
The fixture in `backend/src/lib/researchInterop.test.ts` creates actual Sources
workspaces, Chat transcripts, and completed table cells through Beaver's local
persistence ports. No database reads, transcript extraction, or finding resolution
are stubbed. It validates output membership/order while measuring the unchanged
`previewTable` and `findings` application entry points.

## Reproduce

From `backend`, after installing dependencies:

```sh
BEAVER_FINDINGS_BENCHMARK=/tmp/findings-after.json \
  node node_modules/vitest/vitest.mjs run src/lib/researchInterop.test.ts \
  -t 'benchmarks research findings'
```

For an A/B comparison, make a separate checkout of the baseline commit, install
its backend dependencies, and copy **only the candidate's
`backend/src/lib/researchInterop.test.ts`** over its counterpart. Run the same
command there with a different output filename. The benchmark deliberately uses
only unchanged public operations, so the fixture itself needs no before/after
implementation switch. It is skipped by the normal test suite; no timing
threshold is used as a CI assertion.

Each scenario gets newly created durable data. Setup is outside the timer. The
first operation is recorded separately; medians use seven subsequent operations
(50 for the small single-finding case, where scheduler noise matters). Each
operation constructs its own reader: this tests eliminated work **within a
request**, not a cross-request cache hit. Modules and SQLite may already be warm;
these numbers are not application cold-start or production-network timings.

A separate untimed operation uses V8's allocation sampler at a 16 KiB interval,
including objects collected by minor/major GC. `sampledBytes` is an estimate of
main-thread allocations, not peak RSS, retained heap, or SQLite-worker memory.
Sampler overhead is excluded from latency measurements.

## Recorded local comparison

Linux x64, Node 22.16.0, separate Vitest processes using the same installed
packages. `before.json` and `after.json` contain all measured fields. Run order:
candidate, then baseline. Numbers are illustrative, not performance guarantees.

| Operation | Median before | Median after | Workspace reads before → after | Input loads before → after |
| --- | ---: | ---: | ---: | ---: |
| One finding | 0.995 ms | 0.995 ms | 1 → 1 | 1 table → 1 |
| Preview 100 selected cells | 148.05 ms | 6.76 ms | 102 → 1 | 100 tables → 1 |
| First 50 findings of a 2,000-cell table | 60.38 ms | 34.53 ms | 1 → 1 | 1 table → 1 |
| First 50 findings of a 10,000-cell table | 608.86 ms | 270.86 ms | 1 → 1 | 1 table → 1 |
| Preview 50 selected Chat answers | 151.23 ms | 6.19 ms | 102 → 1 | 50 transcripts → 1 |

Sampled allocations for the 100-cell preview fell from 61.46 MB to 2.18 MB;
for the Chat preview, from 84.14 MB to 2.91 MB. The large listing still allocates
about 102 MB: indexing removes repeated searches, but this change does **not**
push pagination into storage or avoid constructing all findings before slicing.
That limitation is retained rather than disguised as an allocation improvement.

## Correctness and lifetime

One `readFindings(scope, workspaceId)` owns loaded workspaces, raw table details,
raw transcripts, and authorization observations. Chat interpretation remains
workspace-specific. Recursive table references share raw loads across owning
workspaces but never share recursively resolving promises; cycle detection stays
with the traversal. New operations reauthorize and reload, including after failed
reads, document deletion, or Chat deletion.

Table arrangement resolution goes through that reader. Frozen imports still
supply their captured, fingerprinted findings explicitly; the default reader
must never replace that callback with a fresh lookup of regenerated results.
This is not an atomic database snapshot and does not remove final revision/CAS
checks or change local/cloud persistence boundaries.

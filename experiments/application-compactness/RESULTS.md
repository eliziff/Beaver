# Application compactness and read performance

2026-09-05, Windows, local SQLite and filesystem storage. No provider or metered API calls.

## Directory operations

`directory-read.ts` creates 500 Library documents and 500 project documents, then
measures 100-document pages. Each operation has five warm-up iterations and 60
measured iterations. The measurements include authorization, SQL, and application
presentation, but exclude HTTP and browser rendering.

| Operation | Before p95 | After p95 | Reduction | Queries per page |
| --- | ---: | ---: | ---: | ---: |
| Library search | 33.44 ms | 11.24 ms | 66.4% | 101 → 2 |
| Library folder | 29.60 ms | 9.71 ms | 67.2% | 101 → 2 |
| Project directory | 39.37 ms | 8.73 ms | 77.8% | 103 → 4 |

The shared metadata operation loads authorized document heads in batches of up to
200, retaining caller order and omitting inaccessible or missing records. Library,
project, and tabular consumers use it. Single-document reads and mutation locks
share the same SQL projection. Library search and document-only pagination now
apply the cursor, including the document-ID tie-breaker for identical filenames.

## Document opening

`document-read.ts` generates a 1,200-paragraph DOCX and measures real disk reads,
checksum verification, and native compilation. Four simultaneous callers previously
loaded the source four times; they now share one verified load and compilation.
Each workload has five warm-up and 40 measured iterations.

For four callers, aggregate source-read p95 fell from 20.96 to 6.93 ms. Total opening
p95 was 25.57 before and 25.08 ms after, so this is **not** evidence of a 25% total
document-opening improvement. Compilation dominates this fixture. Both runs
produced the same extracted-text SHA-256:
`716444df1c6a5001bf51d9580c886a7038b776384ef951342d48e03e87a80168`.

Readers share verified work while cancellation remains specific to each caller.
A failed source verification does not prevent a later valid retry. Native format
compilers and their legal-structure algorithms were not changed.

## Ownership and size

Spreadsheet presentation and receipt-bound evidence viewing/downloads now belong
to the document application. Evidence titles use the requested version. PDF retry
requests queue from authorized version metadata; the worker performs source-byte
verification. Initial preparation and reprocessing share one worker implementation.

This cut removes **58 nonempty production lines**, using the source measurement
script's counting convention. This excludes concurrent research/memo changes in
`documentRoutes.ts` and the earlier legal-source consolidation. No production code
was moved outside the measured roots, and no experiments were deleted.

The whole-workspace baseline was 93,256 production lines. The later snapshot was
93,620 because other tasks were adding features concurrently. The 68,400-line
target has **not** been reached. The measured improvement here is predominantly
less repeated work, not a large reduction in source size.

## Assistant protocol

The frontend's strict event and citation validation now lives in
`assistantProtocol.ts`. A single field map checks allowed keys and parses values,
reusing the previous bounds, URL checks, defaults, and normalization rules. This
replaces repeated key lists, temporary untyped objects, and field-by-field failure
checks. `assistantSession.ts` retains the reducer and normalized state types.
Every caller imports the parser or URL helper from its owner; no compatibility
exports remain. No dependency was added.

The parser and its consumer updates remove **251 nonempty production lines** in
the files that were otherwise unchanged. The assistant's attachment context also
uses batched metadata, removing two lines and repeated per-document queries.

`assistant-protocol.mjs` compares the captured pre-change parser with the candidate
on all existing supported-event fixtures, complete nested payloads, and systematic
missing/invalid field mutations. All **11,524 cases** produced the same parsed
output or rejection. Existing session tests independently verify transcript replay,
interrupted sends, and atomic final content/citations. No new CI tests were added
for the parser replacement.

For 60 measured batches of 2,800 valid events, after five warm-ups, parser-only p95
was 12.41 ms before and 11.73 ms after. Execution order alternated between samples.
This modest difference is not evidence of a 25% end-to-end assistant improvement.

Before changing the parser, capture its bundle with
`node experiments/application-compactness/assistant-protocol.mjs baseline`.
After the change, run the same command with `candidate`. Baseline bundles and raw
comparison results are ignored artifacts. The original parser is not maintained
as a second implementation.

## Test selection

The document route tests replace a 220-line mocked evidence suite with real
SQLite/filesystem reads, native PDF receipts, exact-version checks, and an XLSX
grid round-trip in 118 lines. Added read tests cover shared cancellation and
checksum failures, authorized metadata batches, and cursor pagination with tied
filenames. Incidental error copy, object identity, and duplicate assertions were
removed. Parser and chat consumer changes use existing behavioral checks.

The subsequent reachability audit removed an unused preliminary DOCX receipt API,
its three tests, and a jurisdiction modal used only by its two tests. The active
tracked-editing implementation, actual Court Records chooser, and their behavior
tests remain. The native-append table test now calls the active table operation
directly, and the provider redirect test exercises the actual queued worker.
This removes a further **286 production lines and 145 test lines**. No experiment
was removed or moved, and no active document compiler was changed.

The queue test exposed a status defect: reading a failed PDF download immediately
queued it again, so callers could never observe failure. Status reads now retain
the failed state; job retries and explicit queuing still own retry execution.
Focused DOCX/provider checks passed 36 tests; the current Court Records chooser
and standalone Authorities checks passed 28 tests.

The attributable production reduction for this task is now **597 lines**:
58 document-operation lines, 251 parser/consumer lines, two attachment-context
lines, and 286 unused-code lines. This remains far below the requested aggregate
target. Test reductions are reported separately and do not count toward it.

## Reproduction

Run from `backend`:

```powershell
.\node_modules\.bin\tsx.cmd ..\experiments\application-compactness\directory-read.ts candidate
.\node_modules\.bin\tsx.cmd ..\experiments\application-compactness\document-read.ts candidate
```

Each script reports progress and writes partial JSON results under ignored
`results/`. Baseline files were captured before their respective implementation
changes. Synthetic input files remain in their temporary directories for inspection.

## Verification checkpoint

- Real SQLite/filesystem tests cover metadata ordering, deduplication, authorization,
  Library pagination, project listing, native PDF receipt binding, and merged XLSX cells.
- Focused PDF retry/worker tests preserve OCR/layout payloads and encrypted-PDF failures.
- Backend TypeScript and source-boundary checks passed.
- Backend behavior run: 1,004 passed, 32 skipped; one quote-check test failed on
  report copy changed by concurrent work.
- Frontend build passed for Beaver, Court Records, and Authorities, including the
  standalone dependency boundary check.
- Frontend behavior run after the parser cut: 840 passed; an AppSidebar suite
  could not load the ConversationsModal file while concurrent work was replacing it.
  After that file appeared, all eight AppSidebar tests and the four build/transport
  boundary tests passed.
  Focused assistant protocol, stream, hook, and presentation checks: 87 passed.
- Existing chat durability/storage checks after batched attachment metadata: 37 passed.
- Standard launcher smoke passed for health, app, Authorities, Library, and model
  catalogue routes. The lifecycle self-test also passed after fixing timestamp
  precision loss during lifecycle JSON decoding. PowerShell's documented
  [timestamp conversion](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/convertfrom-json?view=powershell-7.6#notes)
  explains why string casts of decoded dates stopped matching process identities.
- Assistant-dock smoke passed geometry at six desktop-to-phone widths, and its
  screenshots were visually inspected. The full browser run lost its server
  connection during label creation; subsequent attempts were interrupted by the
  launcher being stopped for concurrent rebuilds. A clean full dock result remains
  outstanding.

# ALR and Authorities completion gates

The implementation branch is `alr-authorities-completion` in each affected
repository. Existing work remains intact; starting revisions and patches are
recorded privately in `benchmarks/local-data/alr-completion/initial.json`.

## Acceptance

1. Common-law-cite stores complete upstream data using upstream field names,
   with authored common-law extensions. Every consumer uses the new schema;
   obsolete tables and interfaces are removed. Canada remains the default.
   Court/body classification, verified neutral identifiers, and CanLII routes
   are separate concepts. Accepted supra tiers are unchanged.
2. Existing manuscript splits, reference targets, keys, URLs, quotation results,
   ALR workbooks and Authorities outputs retain their product behavior. Existing
   independent gold is scored separately from before/after equivalence. An
   intentional engine coverage improvement must be explained by its original
   conformance expectation, never by regenerating expected results.
3. Cold start, steady-state throughput, peak memory and WASM size are measured
   before restructuring and on the candidate. No unexplained performance
   regression passes. Timing samples run serially on the same machine; retain
   individual observations and investigate noise instead of hiding it in a
   permissive threshold.
4. CourtListener works through the page and GovInfo through the native host.
   Public and private WebView2 programs start no HTTP listener. Private journals
   and indexes are included without user path configuration. Public/Word retain
   optional journal support; Word may retain its server. Provider checks use
   public sources and cover unavailable credentials and failed acquisition.
5. Run the actual distributables, verify source acquisition, document import,
   quotation checking, save/reopen and downloaded products. Verify the public
   package excludes private databases and credentials before publication.

Python-style CanLII browser work, model evaluations, shortform experiments and
the separate PDF redesign are outside this task. GPT-5.2 remains the AI default.
This suite does not authorize the separately gated full sweep.

## Engine measurements

`harness.py engine` uses the CLI's production batch API. Supply a frozen JSONL
request file with `method` and `request` in every line. It measures first-response
latency, warms all paths, measures repeated work, queries the child's peak resident
memory, and hashes every response's exact bytes. Fresh processes and repeated
requests must agree. Errors, empty inputs, changed inputs, missing measurements,
changed outputs and regressions fail the comparison. The baseline cannot be
overwritten by the comparison command.

```powershell
python -u -X utf8 benchmarks/alr-completion/harness.py engine --cli <release-cli> --requests <private-jsonl> --wasm <wasm> --out <baseline.json>
python -u -X utf8 benchmarks/alr-completion/harness.py engine --cli <candidate-cli> --requests <private-jsonl> --wasm <candidate-wasm> --schema4 --baseline <baseline.json> --out <candidate.json>
python -X utf8 benchmarks/alr-completion/test_harness.py
```

Conformance inputs retain their checked-in public-source provenance. Private
manuscripts, frozen requests, per-record output and receipts stay under the
ignored local-data directory. Record hashes and the command beside each run.
Builds use the canonical Cargo target and one job. Retain the baseline executable
in that target for an interleaved timing comparison if needed; no extra target
directory or dependency installation is necessary.

The explicit `--schema4` comparison translates the frozen Canadian split
requests from `extendedUs: false` to `jurisdictionPriority: ["ca"]`. For response
comparison it translates only schema-version and Canadian source-part profile
metadata back to the frozen envelope. Other profiles fail that translation;
citation fields, text, spans, keys, URLs and reference targets are untouched.
Raw wire response hashes are retained separately and must also repeat exactly.
This is a documented API-envelope exception, not whole-response byte identity.

The October 2026 candidate passed all 756 frozen requests over five fresh
processes and three warm repetitions per process. On the same Windows machine:

| Measurement | Baseline | Candidate |
| --- | ---: | ---: |
| Median cold response | 276.77 ms | 249.82 ms |
| Median warm batch | 276.26 ms | 226.59 ms |
| Median process peak working set | 399,081,472 bytes | 396,476,416 bytes |
| Release WASM | 8,493,238 bytes | 7,480,533 bytes |

The strict comparison reported no failures. Private `engine-baseline.json` and
`engine-candidate.json` retain individual samples, input and binary hashes,
and response hashes. Memory usage is approximately unchanged;
these measurements describe this frozen workload, not all possible inputs.

## Product equivalence and independent gold

Reuse `benchmarks/alr-verifier/compose.ts` and its existing local-only input/source
stores for complete Free-mode workbooks and quotation output. The maintained
private manuscript harness is `benchmarks/citation-benchmarks-private/tools/arm_engine_parts.mts`;
its `score_splits.py` evaluates the independent gold. The old
`benchmarks/authorities-split` projection is not the production splitting path.
Reuse the Authorities
stress harness for draft/build/export behavior. No model calls are needed.

`harness.py artifacts` hashes an explicit nonempty JSON list of relative output
filenames. Missing files fail; additions/removals in the manifest and changed
bytes fail a baseline comparison. Record deterministic product artifacts separately from run
receipts containing timing and binary identities.

An unchanged baseline repeated before the refactor produced identical citation
and quotation JSON and identical bytes for every XLSX member, but different ZIP
container timestamps. Use the explicit `--zip-members` mode for these workbooks:
it compares every member, rejects duplicate names, and retains the whole-file
hash separately. It never rewrites or omits workbook XML, IDs, source links,
formatting or diagnostic fields. This proves payload equivalence, not identical
ZIP container bytes; the distinction must remain visible in the results.

```powershell
python -X utf8 benchmarks/alr-completion/harness.py artifacts --root <baseline-products> --manifest <files.json> --out <baseline-files.json>
python -X utf8 benchmarks/alr-completion/harness.py artifacts --root <candidate-products> --manifest <files.json> --baseline <baseline-files.json> --out <candidate-files.json>
```

Candidate gates must name the exact source and binary identities. Historical
results and successful focused checks do not stand in for packaged-app proof.
Logs stream to the private run directory; retain one latest candidate directory.

The candidate matched all 45 artifacts from 15 complete manuscripts, including
every XLSX member. The maintained private harness processed 113 manuscripts
through both the frozen baseline CLI and candidate engine: all 21,928 source
parts matched, including the entire output JSONL byte stream. The private
`manuscripts-comparison.json` records the input and engine hashes. Independent
build-partition gold agreement was 344/378 manual splits, 14,333/15,280 cached
machine split labels and 10,695/11,388 cached machine pinpoint labels. Machine
agreement is not human-reviewed accuracy; no new model calls or gold edits were made.

## Native host and deployed sources

`node AuthoritiesHelper/modern/webview/smoke.mjs` checks worker requests, POST,
profile reopen and zero TCP listeners. ALR's `node beaver_app/program/smoke.mjs`
checks the real built page, DOCX import, citation/pinpoint persistence after reopen
and the native resource boundary. Set `BEAVER_CHECKOUT` to the candidate checkout
for ALR builds and checks. Inspect `beaver_app/out/native-smoke/import.png` and
`reopen.png`; those checks passed on October 13, 2026.

Worker deployment `0197ac8e-f4d8-4aea-82e7-e018865a3219` added `/source` to the
existing public service. Live checks passed GovInfo public-record retrieval,
local-file CORS preflight, unsupported-source rejection and unapproved-origin
rejection. CourtListener's live API preflight accepted direct browser access.
These checks do not substitute for running both packaged executables.

## Remaining delivery gates

The Python binding passed all 489 enabled conformance cases (67 remain pending);
the new court-registry consumer preserved all 29 previous court classifications.
The wider Authorities source tests did not pass: 15/44 build tests and 3/24 import
tests failed. These include page-count/link destinations, marking expectations,
Markdown extraction and ledger/projection import behavior. Do not represent this
suite as green or change its expectations to obtain a pass.

The browser stress helper now follows the current import wizard and records
nested error causes even when a case stops. DOCX import and PDF draft reopen
completed, but source-PDF attachment failed with the shared PDF engine error
`line/region annotations disagree`. The retained browser report is
`.tmp/alr-completion-authorities/report.json`; layout-shift assertions also failed.
The separate PDF engine work is in progress and is outside this task. Public HTML
publication and complete Authorities export proof remain gated on resolving this
failure; a successful build alone is insufficient.

Public/internal executable packaging also awaits explicit approval to distribute
Microsoft's unchanged WebView2 license and notice files. No packaged-executable
or publication success is claimed before those gates pass.
The program entry point bundles successfully with only Node built-in external
imports. The existing private journal database and search index pass the package's
schema, size, modification-time and export-identity preflight checks. Neither
check proves that the final executable starts or that its embedded stores work.

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
python -u -X utf8 benchmarks/alr-completion/harness.py engine --cli <candidate-cli> --requests <private-jsonl> --wasm <candidate-wasm> --baseline <baseline.json> --out <candidate.json>
python -X utf8 benchmarks/alr-completion/test_harness.py
```

Conformance inputs retain their checked-in public-source provenance. Private
manuscripts, frozen requests, per-record output and receipts stay under the
ignored local-data directory. Record hashes and the command beside each run.
Builds use the canonical Cargo target and one job. Retain the baseline executable
in that target for an interleaved timing comparison if needed; no extra target
directory or dependency installation is necessary.

## Product equivalence and independent gold

Reuse `benchmarks/alr-verifier/compose.ts` and its existing local-only input/source
stores for complete Free-mode workbooks and quotation output, and
`benchmarks/authorities-split` for the existing split gold. Reuse the Authorities
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

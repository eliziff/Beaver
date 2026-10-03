# Court PDF performance evaluator source

This directory preserves the ten reusable evaluator source files from the
sanitized cloud PDF-performance handoff. **It is an incomplete source archive,
not a runnable benchmark.** The files are unchanged copies; no portability or
scoring fixes were made, and no tests or benchmarks were run for this preservation
commit.

The retained implementation is in `frontend/src/app/court-records/assembly.ts`,
`layout.ts`, and `pdfText.ts`, committed as
`24c8551c95a2a51f8ca19ed6804f456d87b203b3`. The original implementation base was
`fd93595284c4dd8e61f182d1bb252e14e77efd98`. This directory adds no production
dependencies or build integration.

## Provenance and source allowlist

The source archive was `beaver-pdf-performance-code-handoff-20261003.zip`, SHA256
`fda54f090f8f97a0e33929bf41c024e4a58e61297fd12170b7082d93b36b5f1f`.
Each source file was copied from its `evaluator/` member and verified against the
archive's checksum manifest. The ZIP, its implementation patch, and runtime data
are not included here. This README was written for the repository copy.

| File | Preserved responsibility |
| --- | --- |
| `common.mjs` | Repository paths, fixed date, hashing, serialization and arguments |
| `compare.py` | Sequential paired worker orchestration and comparison receipts |
| `final-validate.py` | Final selection and development/held-out orchestration |
| `freeze.py` | Evaluator/fixture identity freeze and verification |
| `no-network.c` | Linux/x86_64 seccomp wrapper for measurement workers |
| `prepare.mjs` | Serialize and seal workloads from the omitted fixture generator |
| `score.py` | Paired timing objective, deterministic bootstrap and guardrails |
| `semantic-audit.mjs` | PDF page, text, label, link, outline and marker inspection |
| `snapshot.mjs` | Assembly bundle and source/dependency identity capture |
| `worker.mjs` | Assembly correctness checks, timing, memory and request accounting |

## Missing inputs and evidence

`prepare.mjs` requires `COURT_PDF_FIXTURES_MODULE`, an explicit path to the private
fixture generator formerly named `fixtures.mjs`. That generator is omitted because it
contains scenario-bearing fixture generation. There are no source PDFs, document
bodies, corpus fixtures, gold data, sealed holdout data, or baseline PDF oracles
in this directory. Those exclusions are not permission to publish them later.

The scripts also expect absent `fixtures/`, `oracles/`, `snapshots/`, fixture and
freeze manifests, final-selection metadata, and other run artifacts. In
particular, `freeze.py` expects a study-specific `PROTOCOL.md`, compiled
`no-network` executable, `machine.json`, and `network-denial-selftest.json`.
Logs, receipts, candidate history, binaries, caches, dependencies, font assets,
credentials, and Library transfer metadata are excluded. The original archive's
README and checksum manifest are not prerequisites for execution and are not
copied here.

Historical speed measurements cannot be reproduced or independently verified
from these sources alone. This preservation commit makes no claim about current
performance, portability, or a newly validated benchmark.

## Portability and side effects

- Path resolution assumes the evaluator directory is two levels below the
  repository root. This location preserves that depth. Several imports resolve
  directly into `frontend/node_modules` and `frontend/public/court-fonts`.
- The original run used Node 24.19.0 and the repository's locked PDF.js, pdf-lib,
  fontkit, rolldown, and TypeScript dependencies. They are not bundled here.
  `freeze.py` uses `Path.relative_to(..., walk_up=True)`, requiring Python 3.12
  or later. No dependencies were installed or upgraded for this copy.
- `no-network.c` uses Linux/x86_64 seccomp; it is not a portable Windows or macOS
  wrapper. Runners require `taskset`, use CPU 2 by default, and start Node with
  `--expose-gc`. `final-validate.py` hard-codes CPU 2. CPU availability and network
  denial must be checked separately for any new environment.
- Workload IDs (`fc-60`, `fc-180`, `abca-60`, `abca-180`), dates, seeds, output
  labels and thresholds retain their original study values. They are not a
  general configuration interface.
- Scripts create files beside themselves, use exclusive creation for some
  outputs, and change snapshot/oracle permissions. `snapshot.mjs` invokes
  repository bundling tools. Do not execute them in this tracked directory or
  against saved evidence. Any future study needs a separate ignored working
  directory, such as `.tmp/<study-name>`, and a reviewed storage/path setup.

## Scoring limits and requirements for reuse

The preserved objective is the geometric mean across workloads of the median
paired candidate/baseline time ratios. Each measured worker performs two warmup
assemblies followed by three timed assemblies. `compare.py` defaults to twelve
paired rounds with alternating worker order. `score.py` uses deterministic
bootstrap resampling and requires both the objective and its one-sided 95%
upper bound to be below 1 for its strict-improvement flag. Per-workload p95 time,
p95 process-peak RSS, and maximum process-peak RSS ratios must each be at most
1.05 for its guardrail flag. These constants do not replace a frozen study
protocol or A/A noise calibration.

The unused multi-file `score.py` CLI has a known limitation: it prefixes pair
numbers with only the receipt basename. Same-named inputs such as `raw.jsonl`
with overlapping pair numbers can overwrite records during grouping. Do not use
that path to pool batches. The scorer also assumes complete, equally sized,
aligned workload rounds; it does not fully validate that assumption. Historical
comparisons used separate complete `compare.py` batches, not this pooling path.
`compare.py` can exit successfully while a score's guardrail or improvement flag
is false; process success alone is not an acceptance decision.

Memory is process high-water RSS, including imports, input loading, warmups and
earlier checks; it is not assembly-only allocated memory. Exact output checks
compare PDF hashes/metadata, receipts and progress to missing baseline oracles;
asset requests and source reads are bounded by baseline counts. The independent
semantic audit depends on omitted fixture markers and oracle PDFs. None of
these checks ran during preservation.

Before reusing the source, independently design permitted fixtures and freeze
the evaluator, protocol, baselines and constraints. Split at source-document or
family level (80% development / 20% sealed held-out), calibrate paired A/A noise
on the new isolated machine, and define the acceptance/repeatability rules
before tuning. Keep failed attempts and do not mix scores across machines or
evaluator versions. Open the held-out set only after selecting the final
incumbent; the original study's holdout has already been consumed. Any genuine
scorer or harness correction needs a new evaluator version and fresh baseline
and calibration, without rewriting historical evidence.

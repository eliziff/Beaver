# Contributing to Beaver

Start with the [README](README.md), [documentation index](docs/README.md) and
[master plan](docs/roadmap/master-plan.md). Keep a change coherent and reviewable:
fix the owning operation and its callers together rather than leaving parallel
implementations or compatibility scaffolding.

## Boundaries

Preserve both account-free local and cloud/Supabase modes. Application operations
share persistence, jobs, document/evidence and UI primitives; deployment adapters
stay at the composition boundary. Local hosting, SQLite and filesystem storage
are existing product capabilities, not a proposed future fork.

Respect [repository ownership](docs/current/local-subrepositories.md). Make shared
engine changes in their standalone repositories and publish reviewed changes before
intentionally advancing consumer pins. System workflows belong to the pinned
`mike-workflows` repository; follow its README and contribution/validation rules,
then refresh Beaver's catalogue with `scripts/build-workflow-catalog.py --bundle`
using an explicit source commit (see [catalogue operations](docs/current/behavior-contracts.md)).
Do not edit generated copies as a second source of truth.

Beaver has no user-migration requirement unless a task explicitly requests one.
Preserve capabilities, not obsolete module boundaries. Do not work through or
consolidate experiments as part of an ordinary refactor. Never commit credentials,
private documents, local stores, model packs or disposable benchmark output.

## Validation

Choose the smallest real behavior check that can catch the change. Tests should
prove public outcomes or resulting state, not replay stubs or internal call order.
During iteration, use focused tests and affected-crate checks; build the integration
boundary once the candidate is ready. Preserve exact corpus/release gates for
native semantic changes.

Install the root dependencies as well as the affected surface dependencies.
Shared contracts and PDF helpers compile with `npm run build:shared`; build,
test and dev commands run that incremental compilation first. Run it once before
direct Vitest or packaging commands.

Source measurements include `.mts` shared contracts; historical counts taken before
that extension was included are not directly comparable.

From the repository root, select the relevant checks:

```sh
node --test docs/scripts/check-docs.test.mjs
node docs/scripts/check-docs.mjs
npm run check:guards
npm test --prefix backend -- <focused-test-name>
npm test --prefix frontend -- <focused-test-name>
npm run check:source-boundaries
npm run build --prefix backend
npm run build --prefix frontend
```

The standalone Authorities page has its own end-to-end proof. `npm run
test:authorities-html-e2e` builds `Authorities.html` (cargo with the `wasm32-wasip1`
target) and drives it in Playwright's Chromium from `file://` and over http, with
invented inputs and a stubbed A2AJ, so it needs no network. It imports a PDF and a
Word brief, edits citations, provides and recognizes sources, highlights, builds every
output and reads the downloads back, asserting the budgets and layout rules at the top
of `scripts/test-authorities-html-e2e.mjs`. Screenshots, downloads and `report.json`
go to `.tmp/authorities-html-e2e/`. `--skip-build` reuses the built page, `--mode=file`
or `--mode=http` and `--only=pdf` or `--only=docx` narrow the run, and `--live` lets
A2AJ answer for real.

`npm run test:authorities-stress` drives the same page through realistic stress: a
public Supreme Court judgment and invented briefs (a Word brief with numbering, tracked
changes, a table and split runs; a brief citing 120 authorities), every court preset and
output setting, drafts, Manual mode, file access and moved files, the Highlights editor,
scans read at once and a reload while they are read, edits while slow sources gather, and
repeated builds. Each case runs in a new profile and fails on jank (input-to-paint, long
tasks, layout shifts, blank or flickering frames). It screenshots and judges each screen at
1440×900 and 1280×720, reads each PDF back and renders its key pages, and opens each .docx
in invisible Word without updating its fields. Two cases need a fixture that is never
committed (a public journal article and the HAR of its lookups, in
`.tmp/authorities-stress-fixtures/long-article/`) and are skipped without it. Results go
to `.tmp/authorities-stress/`; `--only=`, `--skip-build`, `--html=`, `--no-word` and
`--keep-outputs` narrow a run or keep what it built.

The documentation check needs the restored repository checkout. Backend `test`
runs behavior tests only; `npm run check:guards` runs the shared grammar,
source-boundary and export-integrity checks separately. Follow each native repository's agent
instructions for the affected feature profile. Browser/stack prerequisites are in
[safe local testing](docs/current/safe-local-testing.md) and
[end-to-end testing](docs/current/e2e-ci.md).

The backend suite also runs the offline citator-graph and A2AJ bulk-import
builders, which need the shared Python citation runtime pinned in
`backend/scripts/requirements-citations.txt`. Install it into the `python` on
`PATH` with `python -m pip install -r backend/scripts/requirements-citations.txt`
(the source distribution builds with Rust), or install the Windows wheel from
the same release.

Review new test/eval inputs: genuine user prompts and private context must not
become published fixtures, even through paraphrasing or a machine test. Keep the
behavior being tested and independently invent the scenario and data. Private
inputs and raw outputs belong in ignored local storage.

For a release candidate, run both complete application test/build suites and the
launcher-owned production smoke:

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run check:guards
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 smoke
```

A full sweep is separately authorized under [AGENTS.md](AGENTS.md). Do not report
unrun checks, skipped environmental gates or historical results as a passing
candidate. Existing CI failures do not excuse skipping relevant focused checks;
describe the failure and distinguish it from the change under review.

## Documentation and pull requests

Update the existing current contract when behavior changes. Keep priorities and
remaining validation in the master plan and its focused spokes; remove completed
handoffs instead of adding another permanent progress diary. Preserve useful
rationale, licenses and reproducible benchmark receipts, clearly labelled as such.

Before opening a PR, review the complete diff and remove unrelated changes. State
what changed, why, which checks actually ran, and which gates remain. Use explicit
path staging in shared working trees; never sweep in another session's changes.
Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue or
the upstream Mike project's reporting channel.

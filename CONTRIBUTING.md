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
engine changes in their standalone `main` checkouts. First-party changes do not
require consumer pin updates or binding releases. System workflows belong to the
`mike-workflows` repository; follow its README and contribution/validation rules,
then refresh Beaver's catalogue with `scripts/build-workflow-catalog.py --bundle`
from that checkout (see [catalogue operations](docs/current/behavior-contracts.md)).
Do not edit generated copies as a second source of truth.

Beaver has no user-migration requirement unless a task explicitly requests one.
Preserve capabilities, not obsolete module boundaries. Do not work through or
consolidate experiments as part of an ordinary refactor. Never commit credentials,
private documents, local stores, model packs or disposable benchmark output.

## Validation

Choose the smallest real behavior check that can catch the change. Tests should
prove public outcomes or resulting state, not replay stubs or internal call order.
Prefer a small set of production-path end-to-end flows over mocked happy-path
suites. Keep focused independent algorithm/corpus tests and doubles for expensive
providers or hard-to-trigger failure and race cases. Delete superseded mock tests
when the real flow covers their contract.
During iteration, use focused tests and affected-crate checks; build the integration
boundary once the candidate is ready. Preserve exact corpus/release gates for
native semantic changes.

Install the root dependencies as well as the affected surface dependencies.
Frontend development, builds and Vitest read shared TypeScript directly; they
need no shared build. Backend production/dev commands compile shared runtime
with `npm run build:shared`. Focused backend tests read the source directly too.
Run the shared build before packaging or direct compiled-runtime commands.

Use `npm run check --prefix frontend` for an incremental type check. For a narrow
production bundle, `npm run build:app --prefix frontend` or `npm run
build:standalone --prefix frontend` builds only that surface into its latest
`frontend/.tmp/` output, leaving the running application's `dist/` alone.
`npm run build --prefix frontend` still checks and builds all production surfaces.

For a Rust edit, check/test the owning crate first, not the addon or workspace:

```sh
cargo check --offline --manifest-path legal-structure/Cargo.toml -p legal-structure
cargo test --offline --manifest-path legal-structure/Cargo.toml -p legal-structure --lib <test-name>
```

Rebuild the Node addon only when its Rust source changes. Use `npm run native:build`;
this fixes the manifest, target directory, profile and environment. UI, TypeScript
and data-only edits reuse the installed addon. Do not create scratch Cargo manifests
or publish Python/WASM bindings to test a Node consumer.

From the repository root, select the relevant checks:

```sh
node --test docs/scripts/check-docs.test.mjs
node docs/scripts/check-docs.mjs
npm test --prefix backend -- <focused-test-name>
npm test --prefix frontend -- <focused-test-name>
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
`benchmarks/local-data/authorities-stress/long-article/`) and are skipped without it. Results go
to `.tmp/authorities-stress/`; `--only=`, `--skip-build`, `--html=`, `--no-word` and
`--keep-outputs` narrow a run or keep what it built.

The documentation check needs the restored repository checkout. Backend `test`
runs behavior tests only. Shared grammar and export-integrity behavior are checked
once in backend CI. Follow each native repository's agent
instructions for the affected feature profile. Browser/stack prerequisites are in
[safe local testing](docs/current/safe-local-testing.md) and
[end-to-end testing](docs/current/e2e-ci.md).

The Python corpus builders use the local citation source. When testing or
updating a Python consumer, install it with `python -m pip install
./common-law-cite/crates/legal-citations-py`. No tag, published package or
consumer revision update is needed. Node-only changes do not require rebuilding
or publishing Python/WASM bindings.

Review new test/eval inputs: genuine user prompts and private context must not
become published fixtures, even through paraphrasing or a machine test. Keep the
behavior being tested and independently invent the scenario and data. Private
inputs and raw outputs belong in ignored local storage.

Packaging, publishing and downstream binding releases are delivery work, not
prerequisites for checking an edit. Build the affected distributable when it is
being shipped and smoke that artifact once. Native semantic changes retain their
independent corpus/output proof; ordinary edits do not inherit unrelated release
gates or complete application suites.

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

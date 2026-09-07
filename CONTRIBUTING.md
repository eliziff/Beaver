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
then refresh Beaver's existing catalogue through its normal generation path.
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

From the repository root, select the relevant checks:

```sh
node --test docs/scripts/check-docs.test.mjs
node docs/scripts/check-docs.mjs
npm test --prefix backend -- <focused-test-name>
npm test --prefix frontend -- <focused-test-name>
npm run check:source-boundaries
npm run build --prefix backend
npm run build --prefix frontend
```

The documentation check needs the restored repository checkout. Backend `test`
also runs its grammar/source guardrails. Follow each native repository's agent
instructions for the affected feature profile. Browser/stack prerequisites are in
[safe local testing](docs/current/safe-local-testing.md) and
[end-to-end testing](docs/current/e2e-ci.md).

For a release candidate, run both complete application test/build suites and the
launcher-owned production smoke:

```powershell
npm test --prefix backend
npm test --prefix frontend
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

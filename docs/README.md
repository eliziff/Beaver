# Beaver documentation

Start with the [project README](../README.md) for setup and
[CONTRIBUTING.md](../CONTRIBUTING.md) for checks. This is the documentation index;
[the master plan](roadmap/master-plan.md) is the only project-wide status and
priority list.

## Current contracts

| Guide | Owns |
| --- | --- |
| [Architecture](current/architecture.md) | Runtime, application and persistence ownership |
| [Behavior](current/behavior-contracts.md) | Current research, document and UI contracts |
| [Background jobs](current/background-jobs.md) | Durable work, scheduling and delivery |
| [Tool runtime](current/tool-runtime.md) | Tool execution and boundaries |
| [Grounded drafting](current/grounded-drafting.md) | Document generation and evidence |
| [Authorities](current/authorities.md) | Embedded/standalone workflow, highlights and output |
| [Performance](current/performance.md) | Cache/transport/worker contracts, limits and reproduction |
| [Repositories](current/local-subrepositories.md) | Ownership, public submodules and OpenLegalData bundle |
| [Safe local testing](current/safe-local-testing.md) | Isolated data and test environments |
| [End-to-end testing](current/e2e-ci.md) | Browser/stack setup and gates |

Standalone component READMEs own their setup and APIs. The repository guide links
them; this index does not maintain copies of those instructions.

## Plans, decisions and evidence

The [master plan](roadmap/master-plan.md) links every focused roadmap. Roadmaps
specify remaining work and acceptance evidence; they do not certify that a feature
has shipped or that a release gate passed.

[Decisions](decisions/) retain durable rationale. Useful entry points are
[untrusted-source effects](decisions/untrusted-source-effects.md),
[durable work](decisions/durable-work.md),
[document actions](decisions/document-actions.md), and
[structure evidence](decisions/document-structure-evidence.md).
Historical proposals are not a second current architecture.

[Experiments](experiments/) and [Harvey Labs](harvey-labs/README.md) own experimental
protocols, results and decisions. Their recorded revisions, denominators and
reproduction limits matter; an old result is not validation of a new binary.

## Keeping the documentation small

Update the existing owner when behavior changes. Keep current facts in `current/`,
remaining work in `roadmap/`, and lasting rationale in `decisions/`. Remove completed
handoffs and duplicated plans; Git retains their history. Do not add root-level
progress diaries, transcript appendices or a second normative specification for
an existing contract. Preserve useful benchmark receipts and notices.

Run `node docs/scripts/check-docs.mjs` on a restored checkout. It checks root guides,
local links, status directories, roadmap reachability and the Harvey Labs index.
Its focused tests are `node --test docs/scripts/check-docs.test.mjs`.

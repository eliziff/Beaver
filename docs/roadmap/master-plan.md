# Beaver master plan

This is the single project-wide priority and status list. Current contracts live
in [the documentation index](../README.md); focused plans below retain their
acceptance requirements. Reviewed against published code on September 7, 2026.
Implementation present, focused validation and release readiness are distinct.

## Priorities and remaining gates

| Order | Workstream | Current position and next work |
| --- | --- | --- |
| 1 | [Application boundaries](application-boundaries.md) and [document storage](document-versioning.md) | Existing application/persistence owners are the foundation. Finish remaining policy cuts, version/blob lifecycle proof and exact process/native identities; do not recreate the displaced Authorities gateway. |
| 2 | [Shared document structure](document-structure.md) | The standalone Rust engine exists. Preserve primary profiles and quotation ownership; separately establish compound-document gold and gate the exact structure/parser/Inspector/Beaver combination. |
| 3 | [Document capabilities](document-capabilities.md) | Complete exact-target Word operations, linking and quotation workflows under their separate kernel, agent, live-Word and accepted-legal-gold gates. A tool or demo is not full property coverage. |
| 4 | [Legal work products](legal-work-products.md) | Authorities uses the TypeScript core in embedded/standalone hosts, with review and editable highlights. Close reference parity, durable binding/reopen and exact court-output/browser gates; do not claim all profiles filing-ready. |
| 5 | [Saved research](research-sets.md) | Research-file foundations, the current Sources/Memo/Table UI and conversion routes are present. Remaining work is end-to-end round trips, configured live layout quality, scale/performance and Library polish—not recreating the historical overhaul. |

**Bootstrap blocker:** public upstream does not serve the pinned `mike-workflows`
commit. Publish that history or explicitly gate a replacement; the
[repository guide](../current/local-subrepositories.md#fresh-checkout) records the
exact pin and failure. A passing documentation check is not bootstrap certification.

The current [Authorities contract](../current/authorities.md) replaces the old
Python integration/hosted-pilot assumptions. CanLII remains a manual navigation
and attachment handoff; a Downloads-folder watcher is not a planned substitute.
The [performance guide](../current/performance.md) records implemented mechanisms
and their limits, not another optimization backlog or a blanket speed guarantee.

## Constraints

Preserve account-free local and cloud/Supabase modes through one application and
thin adapters. Reuse existing operations, jobs, document versions, evidence,
queries, UI and persistence. Exact receipts are version-bound; untrusted sources
cannot authorize effects. Structure semantics, PDF mechanics and application
policy keep their separate owners.

Retain one UI/core across standalone and embedded work products, and shared Word
operation contracts across Library/live-host executors. Respect Git links, locks,
bundles and native identities. No migrations/compatibility layers unless requested,
second research/ontology store, feature SDK, plugin marketplace or graph framework.
Vectors need held-out benefit, not speculative adoption. Do not turn a refactor
into experiment cleanup.

Preserve accessibility and actual browser/dock proof. No court login, payment,
filing, service or docket automation; no automated CanLII acquisition. Metered
model calls and private-document transmission require explicit authorization.

## Retained backlog and limits

Finish reproducible fresh-checkout/bootstrap paths, pinned offline workflow
catalogue refresh/export, legal-work-product interoperability, measured source/
PDF performance and accessibility. Provider-specific work needs a supported,
validated runtime; blocked Muse work is not a shipped provider. Research NoteUp
use of personal annotations and exact change-impact propagation remain follow-on
work, not implied automatic synchronization.

A renewed hosted Authorities pilot requires an explicit current-product deployment
decision and tested authentication/origin, bounded recovery, retention/deletion,
backup, output-fidelity and accessibility controls. The former Python/VPS recipe
is not an implemented or approved confidential-document deployment.

## Measurement and release

Use `npm run measure:source` and the existing source-budget checks with exact
baseline/candidate revisions. Report production, tests and experiments separately.
The original boundary-program baseline (69,783 production lines), acceptance
ceiling (68,400) and stretch target (67,700) describe that frozen workstream scope,
not a fresh measurement of today's application. Do not silently change scope or
present historical counts as current results.

[CONTRIBUTING.md](../../CONTRIBUTING.md) owns shared validation commands. Each spoke
adds its necessary corpus, output or host proof. Release only the exact pinned
combination that passed those gates; do not substitute cached-extraction parity
for the full PDF lifecycle, mock tests for real-host behavior, or one passing
profile for every court product. Full sweeps require the authorization in
[AGENTS.md](../../AGENTS.md).

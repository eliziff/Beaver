# Beaver documentation

This index is the only documentation catalog. Directory names are status:
`current/` ships, `roadmap/` is approved but unfinished, `experiments/`
is unpromoted, and `decisions/` records adopted or rejected choices. A dated
document does not become backlog merely because it describes unfinished ideas.

## Current production contract

- [Background jobs](current/background-jobs.md) — implemented database queue,
  PDF preparation policy, security boundary, and remaining release gates.
- [Tool runtime](current/tool-runtime.md) — the sole assistant/tool execution
  contract.
- [Grounded drafting](current/grounded-drafting.md) — evidence receipts and
  document-generation safety.
- [Behavior contracts](current/behavior-contracts.md) — durable user-visible
  outcomes worth protecting.
- [End-to-end CI](current/e2e-ci.md), [safe local testing](current/safe-local-testing.md),
  and [local subrepositories](current/local-subrepositories.md) — release and
  checkout operations.

The repository [README](../README.md) is the product overview. Current
subrepository behavior comes from the
[legal PDF parser](../legal-pdf-parser/README.md) and
[AuthoritiesHelper](../AuthoritiesHelper/README.md) repositories, not from old
Beaver design notes.

## Approved roadmap

Only this section is backlog.

- [Master plan](roadmap/master-plan.md) — priority, implementation status, and
  release authority.
- [Acceptance requirements](roadmap/acceptance.md) — detailed user-facing
  acceptance language; it does not override master-plan status.
- [Canonicalization and contraction](roadmap/contraction.md) — active
  architecture and line-count reduction.
- [Shared document structure](roadmap/document-structure.md) — exact Rust
  detector consolidation, Beaver call boundary, OCR/Luna seam, and cross-product
  cutover.
- [Scalable collections](roadmap/collections.md) — approved collection/storage
  work.
- [Shared legal data and tool UI](roadmap/shared-legal-data.md) — approved
  provider-neutral legal-data work.

## Adopted decisions and research conclusions

These documents explain a settled boundary or evidence-backed choice. They are
not parallel implementation plans.

- Security and authority: [untrusted-source effects](decisions/untrusted-source-effects.md),
  [durable work](decisions/durable-work.md), and
  [grounded session state](decisions/session-context.md).
- Assistant efficiency: [context compaction](decisions/context-compaction.md),
  [minimal evaluation/context](decisions/minimal-evaluation-context.md), and
  [retrieval](decisions/retrieval.md).
- Documents: [deterministic actions](decisions/document-actions.md),
  [document mutation](decisions/document-mutation.md),
  [family/text reuse](decisions/document-family-text-reuse.md), and
  [ALR macro portability](decisions/alr-macro-portability.md).
- Legal data: [ALR independence](decisions/alr-independence.md),
  [provider structure](decisions/provider-structure.md),
  [document-structure evidence](decisions/document-structure-evidence.md),
  [source-structure cutover results](decisions/source-structure-cutover-results.md),
  [citation grammar](decisions/citation-grammar.md),
  [citators](decisions/citator.md), and
  [authorities ordering](decisions/authorities-ordering.md).
- Product boundaries: [legal ontology graph](decisions/legal-ontology-graph.md),
  [legal skills](decisions/legal-skills.md),
  [reinvention ledger](decisions/reinvention.md),
  [capability survey](decisions/capability-survey.md), and
  [upstream contributions](decisions/upstream-contributions.md).
- Conditional or rejected: [static-shell decision](decisions/static-shell.md)
  keeps Vite/React but rejects browser-prompt and inequivalent native-control
  substitutions; [Muse provider](decisions/muse-provider.md) remains blocked
  until a real provider contract is available.

## Unpromoted experiments

Nothing here may be imported by production or described as shipped.

- [Context-compaction track A](experiments/context-compaction-track-a.md) and
  [track B](experiments/context-compaction-track-b.md) are evidence behind the
  adopted compaction decision.
- [Legal structure graph](experiments/legal-structure-graph.md) and
  [vision-rendered context](experiments/vision-rendered-context.md) retain their
  own promotion gates.
- [Harvey Labs study catalog](harvey-labs/README.md) indexes every protocol,
  amendment, result, decision, and reproducibility route.

## Documentation rules

- Add current behavior to an existing `current/` document, not a dated plan.
- Add approved work to the master plan and at most one subsystem roadmap.
- Put a hypothesis in `experiments/`; promote its proven contract and tests,
  then delete the experimental production path.
- Record a rejected approach in `decisions/` only when the reason prevents
  likely reinvention.
- Run `node docs/scripts/check-docs.mjs` after moving or linking documents.

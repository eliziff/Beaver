# Saved research: remaining work

Status and priority: [master plan](master-plan.md). The research-file foundation,
Sources/Memo/Table interaction and preview/accept conversion routes are present.
The [current behavior contract](../current/behavior-contracts.md) is normative for
the implemented UI; the old overhaul specification and handoff are superseded.
This plan does not declare the remaining release gates passed.

## Preserve the implemented model

Research is one ordinary versioned Library file, including its optional Markdown
memo, exact source/version references, labels, explicit highlights and receipts.
Reading/searching a passage does not silently create a highlight. Source labels
and highlight types solve different tasks; either, both or neither may be used.
There is no global Library ontology, parallel research store or pseudo-Unclassified
label. A highlight type owns its colour—no independent pen palette or overrides.

The current Sources UI is one nested label tree: a source can appear under each
label it carries, with unlabelled sources at the root. Clicking expands; opening
the reader is explicit. Do not reinstate the superseded mockup's separate label
navigation/source-list design or its verbose inspector panels.

Human and assistant operations share the same mutation, revision and undo/history
boundaries. A read-only preview is not acceptance. Conversions reuse saved data
and exact provenance; they do not parse generated prose back into source facts.

## Remaining validation and product work

| Gate | Required evidence |
| --- | --- |
| Full round trips | Launcher-owned app and real native reader: chat to research, research to table, table back to research, memo citations, save/reopen, reload and undo/redo. Exercise main and assistant-dock placements. |
| Live layout quality | Configured, authorized model runs on representative research questions. Judge useful rows/columns and faithful assignments, not just schema validity. Record the model/provider/revision and distinguish cached or mocked checks. |
| Scale and responsiveness | Large source sets, label hierarchies, passage pagination and conversion previews. Measure real route/UI work, cancellation and stale-response handling; reject silent truncation. |
| Library polish | Ordinary create/open/save/history/restore behavior, discoverability and exact links without extra workspace chrome or another lifecycle. |
| Follow-on integration | Personal annotation use in NoteUp and later explicit refresh/remapping need separate implementation and proof; no automatic synchronization is implied. |

## Acceptance cases that must survive

- Exact source IDs, versions, evidence receipts and memo citation targets survive
  every round trip. A source with labels only, highlights only, both or neither
  remains usable. Renaming/reparenting labels does not rewrite source evidence or
  memo citation text. Deleting a mark/type preserves backing receipts as required,
  falls back to ordinary Highlight where applicable, and does not resurrect marks
  on a later read.
- Chat conversion includes materially used grounded sources, not every incidental
  read. Selecting a table row means that row across its columns; selected sets and
  filters are intersections, not permission to include the whole workspace.
- Preview reuses classifications, saved evidence and grounded results, distinguishes
  pending/missing/conflicting data, and does not equate absence with No or a quote
  with an analytical answer. Hierarchy/layout suggestions are reviewable; exact
  accepted operations are deterministic.
- Model layouts may reference only real source/row/claim identities. Reject invented
  scalars, unsupported evidence and overlapping whole-answer/claim assignments.
  Acceptance makes no second model call, rechecks the fingerprint/version/revision,
  and atomically freezes membership, cell values and provenance. Later label or
  source changes cannot silently rewrite the accepted table.
- Exercise cross-account, unavailable/deleted/revoked source, stale revision,
  partial failure, cancellation and oversized inputs. Existing limits (500 rows,
  25,000 items) must fail explicitly rather than truncate. Preserve completed
  results when adding sources to an existing table.

Use disposable compatible stores for tests. Do not reset the user's data, revive
retired global-label ownership, or invent migrations to make an old handoff run.
Record focused checks honestly; screenshots, real-host round trips and authorized
live quality are separate evidence, not inferred from unit tests.

# Saved research

Status/order: [master plan](master-plan.md). Implemented product behavior belongs
in the [Sources contract](../current/behavior-contracts.md#sources-workspace) and
[interoperability contract](../current/behavior-contracts.md#research-interoperability),
not the superseded root handoff.

The foundation, Sources/Memo/Table cleanup and remaining conversion work form
one research lineage. Library remains neutral. Source virtual folders and the
single highlight-type hierarchy are independent. Reads remain background
provenance. Sources/Chat/Table conversions reuse existing findings and support;
previewed snapshots, explicit promotion and ordinary reversible proposals avoid
live taxonomy synchronization and new ontology machinery.

## Validation and release boundary

Focused route/repository tests cover prefilled answers, unrun questions,
original support and claim-index identity, exact scopes, later answers reusing
earlier receipts, stable snapshot rows, stale previews, refresh/accept/undo,
column-label proposals and atomic pinned Library collection. Model-adapter tests
validate mappings with controlled outputs, not the quality of a live model.
Frontend tests cover conversion/edit/approval/error paths and promotion choices.

Reproduce the focused suites without the unrelated full CI battery:

```sh
cd backend
node node_modules/vitest/vitest.mjs run src/routes/researchViews.test.ts src/routes/sourceWorkspaces.test.ts src/lib/researchFileV2.test.ts src/lib/tabular/researchImport.test.ts src/lib/tabular/researchArrangement.test.ts src/lib/__tests__/relationalDatabase.test.ts src/lib/__tests__/relationalUserPreferencesRepository.test.ts
node node_modules/typescript/bin/tsc --noEmit
cd ../frontend
node node_modules/vitest/vitest.mjs run src/app/components/legal src/app/components/tabular src/app/components/assistant/ChatResearchSave.test.tsx src/app/components/documents/DocTable.interaction.test.tsx src/app/components/shared/ResearchSelectionLabels.test.tsx src/app/components/shared/DocumentSidePanel.highlight.test.tsx src/app/components/shared/DocumentSidePanel.removal.test.tsx src/app/lib/api/researchFiles.test.ts src/app/lib/groundedAnswers.test.ts
node node_modules/typescript/bin/tsc --noEmit
cd ..
node scripts/check-source-boundaries.mjs
node scripts/check-typescript-surface.mjs
python scripts/test-research-interop-components.py /tmp/research-interop-proof --chromium /path/to/chromium
```

The last command exercises actual compiled production components with synthetic
transport in desktop/mobile Chromium. It is **not** the launcher/native-app gate
and makes no live model call. Do not infer full-stack proof from fixture screens.

Remaining release verification needs a configured native app environment:

- Run `scripts/mike.ps1 smoke -WithAssistantDock`, existing Sources and Table
  browser scripts, and inspect screenshots in both full and narrow placements.
- Run the native-dependent reader/extraction/tool cases against the pinned
  `legal-structure-node` addon. Missing-addon failures are not CI fixes in this
  research feature change.
- In an authorized live research run, explore in Chat, convert selected grounded
  work to Sources and a prefilled Table, run only new questions, promote evidence,
  and verify reopen, refresh proposals and undo. This checks semantic quality as
  well as transport; fixture/model-double tests do not establish it.
- Repeat persistence/authorization on the supported cloud composition and native
  document corpus. The shared ports remain unchanged; local route tests alone do
  not prove every cloud/native integration.

The foundation uses pre-release local schema 17. Preserve old data and use a fresh
isolated `MIKE_LOCAL_DATA_DIR` when testing an older checkout's database. This
conversion work adds no schema bump, migration or automatic data reset.

## Separate approved backlog

NoteUp consumption of personal saved annotations is not part of the research
conversion feature. Project-only notes must never leak into personal NoteUp.
Any further work follows the master plan rather than reintroducing completed
handoff tasks or a global research classification system.

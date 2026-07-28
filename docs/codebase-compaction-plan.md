# Beaver codebase compaction

## Objective

Remove parallel implementations while preserving local mode, Supabase/cloud
mode, Hansard, legal-source fidelity, document-version semantics, and the
current user-visible feature set.

Local SQLite and local files are the canonical runtime. Cloud support is a
lazy auth, persistence, and object-storage adapter over the same workflows,
not an equal-weight second application.

Target: delete 4,800–7,400 authored production lines and 200–300 repeated test
lines. Generated data moved out of TypeScript is reported separately and is not
counted as an authored-code reduction.

## Method

1. Make one chat turn and tool-execution path canonical. Put transcript and
   identity persistence behind the smallest SQLite and Supabase operations the
   workflow actually uses. Delete the second streaming engine.
2. Make one tabular generation and chat workflow canonical. Keep local and
   cloud differences at persistence and file-storage calls only.
3. Make document, Library, project, and project-chat routes express business
   rules once. Preserve storage-specific operations without introducing a
   generic repository framework or a Supabase-compatibility emulator.
4. Move neutral PDF artifact loading, validation, locator normalization, and
   lookup into `universal-legal-pdf-engine`'s versioned CLI/JSON contract.
   Beaver retains scheduling, shared-cache coordination, and application
   integration.
5. Reduce Assistant and Tabular Review streams through one frontend event
   reducer.
6. Replace the hand-written workflow source parser and generated TypeScript
   payload with a checked-in versioned data manifest and a small typed loader.
7. Replace repeated Supabase integration-test fakes with one deliberately
   limited helper.

## Non-goals

- Do not remove Hansard.
- Do not remove or hide cloud/Supabase support.
- Do not maintain superseded private compatibility paths.
- Do not copy mikelocal's Supabase query emulator.
- Do not split large files merely to improve file-size optics.
- Do not move code into another package and report that as deletion.
- Do not remove useful warmup or trade interaction speed for build numbers.
- Do not add runtime dependencies.

## Clean-room shell experiment

The current codebase is not a compatibility target. Before spending the whole
budget consolidating its frontend, build a disposable vertical slice that:

- uses a static React/Vite client served by the existing Express process;
- keeps one browser code path for local and cloud deployment;
- implements Assistant, Library, and Authorities against the existing API;
- uses native routing primitives, forms, dialogs, popovers, and CSS where they
  suffice;
- keeps one resource cache and one SSE event reducer; and
- adds no desktop wrapper or second backend.

The resulting static assets must be deployable independently of the local
launcher, with runtime API configuration and optional Supabase authentication.
No user workflow may branch on local versus cloud storage.

Compare the slice with the same current routes. Continue the clean-room rewrite
only if it cuts representative authored UI code by at least 40%, production
JavaScript by at least 30%, and clean build time by at least 50%, without
regressing first-frame stability, warmed navigation, accessibility, or first
assistant token. Otherwise discard it and continue the in-place reductions.

## Baseline Mike contributions

Beaver does not retain architectural compatibility merely to make upstream
patches easy. Discoveries are contributed to baseline Mike as focused changes
to neutral React components, deterministic legal/document functions, provider
logic, tests, and measured performance fixes. Beaver-specific local storage,
launching, and distribution remain downstream concerns.

## Execution order

Run the clean-room shell experiment first. Then start with isolated strict wins:
frontend event reduction, workflow data loading, and test fakes. Converge chat
and tabular execution next. Consolidate document/Library/project rules after
the canonical persistence boundary is proven. Move PDF-neutral behavior last
because its contract affects an independent repository.

Commit an independently testable deletion when practical. Revert any tranche
that increases production source, bundle size, startup time, or representative
interaction latency without deleting a larger demonstrated risk.

## Acceptance gates

- Account-free local and Supabase/cloud test paths pass.
- A normal local start does not import, initialize, or require Supabase or R2.
- The static client can target a separately hosted cloud API without a rebuild.
- Neutral fixes remain expressible as small baseline-Mike patches without
  importing Beaver's local runtime.
- Document uploads and consolidated assistant edits retain existing durable
  version semantics.
- Exact evidence, pinpoints, fragments, hashes, and receipts remain durable.
- Provider capabilities still determine model and effort choices.
- Backend and frontend production builds pass.
- Focused tests pass during each tranche; full repository checks pass at the
  release gate.
- Before/after production lines, generated TypeScript, frontend chunks,
  backend startup, and relevant interactions are recorded with the same
  commands and machine.
- The final result has fewer implementations, not merely more abstractions.

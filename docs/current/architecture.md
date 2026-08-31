# Beaver architecture

Status: current production contract

Beaver is a modular monolith with a small number of justified process and
language boundaries. Product behavior lives in application operations; local
and cloud are compositions of those operations, not separate products.

## Runtime topology

```text
Vite/React browser and Word task pane
              |
       Express routes and SSE
              |
       application operations
              |
 persistence ports and process gateways
       /             |              \
SQLite/files     Postgres/S3      Rust/Python/Codex
```

- `frontend/src/main.tsx` and `frontend/src/app/router.tsx` mount the one browser
  application. `frontend/word.html` selects the Word route in that application;
  it is not a second frontend.
- `backend/src/api.ts` mounts HTTP routes. Routes authenticate, validate HTTP
  input, call an operation, and write the HTTP response.
- `backend/src/runtime.ts` is the composition root. It selects local or cloud
  adapters once and constructs the same application operations.
- `backend/src/server.ts`, `backend/src/index.ts`, `backend/src/worker.ts`, and
  `backend/src/supervisor.ts` are deployment/bootstrap edges, not domain code.

## Canonical application owners

| Capability | Application owner | Persistence or process edge |
| --- | --- | --- |
| Documents and immutable versions | `backend/src/lib/documentApplication.ts` | `documentRepository.ts`, `relationalDocumentRepository.ts`, `storage.ts`, `filesystemObjectStorage.ts` |
| Library folders and documents | `backend/src/lib/libraryStore.ts` | `relationalLibraryRepository.ts` plus the document application |
| Projects and project documents | `backend/src/lib/projectStore.ts` | `relationalProjectRepository.ts` plus the document application |
| Chats and assistant turns | `backend/src/lib/chat/chatApplication.ts`, `backend/src/lib/chatStore.ts`, `backend/src/lib/chat/turnEngine.ts` | `relationalChatRepository.ts`, `chatTurnQueue.ts`, provider adapters |
| Tabular reviews | `backend/src/lib/tabular/application.ts` | `relationalTabularRepository.ts`, ordinary jobs and agents |
| Workflows | `backend/src/lib/workflowRepository.ts` until the application operation in the active boundary plan lands | `relationalWorkflowRepository.ts` |
| Account and user preferences | `backend/src/lib/userApplication.ts`, `backend/src/lib/userPreferences.ts` | `relationalUserPreferencesRepository.ts`, environment credentials, optional `supabaseUserAccount.ts` |
| Legal sources | provider registry and `backend/src/lib/legalSourceStore.ts` | provider adapters, `OpenLegalData`, and the document projection service |
| Authorities | `backend/src/lib/authoritiesWorkspaceApplication.ts` | work-product and document persistence plus shared native legal-structure/PDF operations |

`backend/src/routes/tabular.ts` is the reference route shape: an injected
application, explicit schemas, and HTTP-only response work. The unfinished
route/application cleanup is tracked in the
[application-boundaries plan](../roadmap/application-boundaries.md).

## Local and cloud

- Account-free local mode uses anonymous local identity, SQLite, filesystem
  objects, and environment/provider credentials.
- Cloud mode adds Supabase identity, Postgres, private object storage, sharing,
  MFA, audit, and account administration.
- Routes, application rules, DTO semantics, document versions, assistant
  events, tools, workflows, and UI behavior are shared.
- Feature code never imports deployment adapters or chooses a persistence mode.
  Unsupported cloud-only account operations fail explicitly at the injected
  capability boundary.
- Beaver has no users. Replacements update every caller and delete the displaced
  design; there are no migration frameworks, compatibility DTOs, dual reads,
  or transition flags unless explicitly requested later.

## Document and legal-data ownership

- Growing collections use bounded keyset pages, server-side filters, exact-ID
  reads, and shared cursor semantics. Local metadata lives in SQLite with FTS
  where needed; cloud repositories implement the same resource behavior.
- Provider databases, importers, schemas, and shared source caches live under
  the versioned `OpenLegalData` contract, normally beneath
  `%LOCALAPPDATA%\OpenLegalProducts\LegalData`. SQLite is the runtime format;
  analytical formats and readers are import-time tools only.
- Immutable source bytes and document versions are authoritative.
- `documentProjectionService.ts` is the only cross-format document-read host
  boundary. Format work remains in `legal-pdf-parser`, opaque Rust
  `NativeDocument` handles, raw-preserving DOCX sessions, and spreadsheet grids.
- `legal-structure` owns provider-neutral legal structure and bounded structure,
  citation, locator, and text-coordinate operations.
- `legal-pdf-parser` owns PDF extraction, geometry, OCR routing, and PDF
  witnesses. It pins a gated `legal-structure` revision and contains the single
  synchronized PDF Inspector branch.
- Provider-native facts are preserved. Beaver does not maintain a parallel
  TypeScript structure engine or a lossy universal document AST.
- Exact source versions, locators, hashes, evidence, mutation manifests, and
  receipts are durable. Model prose is not authority.

## Assistant and agent ownership

- `backend/src/lib/chat/turnEngine.ts` is the one provider-neutral turn engine.
- `backend/src/lib/chat/toolRegistry.ts` owns executable tools and lazy exact-name
  loading. A schema without a handler is not a capability.
- Chat, subagents, and tabular review are different presentations of ordinary
  agent work, not separate model runtimes.
- Provider wire events remain private to provider adapters. Public assistant
  events cross one validated SSE boundary and feed one frontend reducer.
- Long work uses the existing durable job queue, cancellation, progress, and
  partial-result behavior.

## Standalone and embedded capabilities

Authorities and the Affidavit and Exhibit Builder each have one maintained
capability core and browser UI. A standalone shell supplies local files and
downloads; Beaver supplies Library versions, persisted outputs, and receipts.
Neither product gets a second engine, UI, store, worker, or local/cloud branch.

## Dependency rules

- Prefer existing operations, repositories, jobs, UI components, and process
  gateways before adding code.
- Add no service, registry, generated SDK, event bus, or one-implementation
  interface merely to move code between files.
- Keep routes transport-specific and application operations host-neutral.
- Keep persistence records internal; application presenters own public resource
  shapes.
- Cross-language boundaries use the smallest typed N-API call or validated
  versioned JSON/process envelope that the consumer needs.
- Run `npm run check:source-boundaries` whenever composition, storage, document,
  provider, or process boundaries change.

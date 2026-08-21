# Beaver behavior contract inventory

Status: Phase 0 deletion gate

Baseline: `269bd0b0`

This inventory names behavior that the contraction refactor must preserve. It
does not make current files, mode branches, Supabase query chains, SQLite
schemas, environment switches, or incidental response wording into contracts.
Each vertical slice replaces all implementations of an operation, proves the
listed behavior through the shared contract, and deletes the old path.

## Application contract

Every ordinary operation receives an authenticated `AuthContext`, applies the
same validation and authorization rule, and returns the same status and DTO in
local and cloud deployments. Only persistence and blob mechanics differ.

| Resource | Observable operations to preserve | Current owner / split to remove |
| --- | --- | --- |
| Library | page/search files and templates; create, rename, move, and recursively delete folders; upload, rename, annotate, move, and delete documents; stable keyset cursors | shared `routes/library.ts`; local/cloud stores encode persistence |
| Documents | list or fetch owned documents; upload; display/download original or requested PDF rendition; version list/create/rename/replace/delete; optimistic assistant version writes; tracked-edit accept/reject; ZIP download | shared `routes/documentRoutes.ts`; local/cloud stores encode persistence; receipt-bound local PDF display remains an explicit extension |
| Projects/matters | page/create/read/update/delete; attach/detach/move documents; folders; people where supported; project chats; reject foreign project/document IDs | mode branches in `routes/projects.ts`, graph-store calls, and Supabase queries |
| Workflows | system catalogue and detail; user workflow CRUD; hidden workflows; archive/open-source; sharing is an explicit cloud account extension | mode branches and separate catalogue rules in `routes/workflows.ts` |
| Tabular reviews | page/create/read/update/delete; columns/cells; clear/generate; attached documents; chat list/read/update/delete; deterministic citations | local-store and Supabase branches plus a separate model loop in `routes/tabular.ts` |
| Chats | page/create/read/update/delete/restore/permanent-delete; project scope; optimistic transcript version; stop; title generation; user turn, input continuation, assistant events, citations, and partial-turn recovery | JSON local store and local turn loop versus Supabase rows and `runLLMStream` |
| Activity history | scoped chat, document, and tabular events; literal title search; bounded paging; CSV export safe from spreadsheet formulas | shared relational audit store in both modes |
| Legal sources | provider search/fetch, native/recovered structure, exact lookup, evidence rehydration, safe links, optional local PDF artifacts | provider-specific caches, SourceDoc paths, and tool-specific result shaping |
| User/account | shared preferences; local environment keys; cloud identity, account, authentication, keys, connectors, MFA, sharing, and export | intentionally deployment-specific administration; not an excuse for ordinary resource branches |

Collection contracts are common across resources:

- default and maximum limits are bounded;
- ordering is stable and deterministic when primary sort values tie;
- cursors bind resource, normalized filters, ordering, and last row;
- a cursor from another resource or filter is rejected;
- exact-ID reads do not scan a page;
- searches are literal user searches, not SQL/regex fragments; and
- every owner/scope predicate is applied before returning payload or existence
  information.

## Document and blob contracts

A document version is immutable identity plus authoritative bytes. Operations
may derive `SourceDoc`, `Grid`, `DocxSession`, PDF, preview, or cache artifacts,
but an artifact cannot replace or silently normalize its source.

The durable version contract includes:

- document ID, version ID, monotonic version number, source hash, media type,
  filename, size, timestamp, and parent/provenance where applicable;
- one assistant turn creates at most one new version per edited document;
- an expected-parent mismatch makes no write;
- replacing bytes invalidates derived artifacts and assistant provenance;
- deleting a version cannot delete bytes referenced by another version;
- original download returns the requested version, not the current version;
- display may create a PDF rendition on demand without changing the original;
- rendition failure leaves native Office display/download available;
- exact evidence binds document, version, source hash, locator, and passage;
- tracked-edit acceptance/rejection is conflict-safe and receipt-bearing; and
- unchanged OOXML parts and accepted/redline text pass the DOCX fidelity gates.

The `269bd0b0` baseline deliberately stopped producing Office PDF renditions
during writes. `GET /single-documents/:id/display` already requests the
rendition when needed. Conversion runs outside the SQLite transaction; the
normal four-worker backend suite is the regression check for this rule.

## Assistant turn contract

Normal, project, read-subagent, and tabular assistant work must converge on one
turn runner. The runner preserves these mechanics:

1. validate the turn and optimistic transcript version;
2. assemble system, history, current input, file manifest, jurisdiction, and
   prior exact evidence without preloading whole attachments;
3. stream provider-neutral content and reasoning;
4. execute bounded registered tool rounds with exact call/result pairing;
5. serialize mutations per affected document while allowing independent reads;
6. enforce project/document scope before tool execution;
7. persist partial events on abort/error and one completed turn on success;
8. require exact legal evidence for grounded legal output and reject invented
   legal-source URLs; and
9. finish with final citations, transcript version, and `[DONE]` once.

Tool schemas and handlers are one definition. An advertised tool must have a
handler; an unavailable capability is omitted, not accepted and failed later.
Unknown tools return a bounded structured error. Provider transports remain
replaceable and Claude-P remains a supported transport.

Current engines to delete after callers move:

- local `streamAnonymousChat` plus `runLocalAssistantTools`;
- cloud/general `runLLMStream` plus `runToolCalls`;
- tabular generation/chat loops; and
- read-subagent orchestration that duplicates parent runner mechanics.

## Canonical assistant events

Tool and reasoning activity may stream immediately. Assistant prose is buffered
until grounding succeeds, then released once with its citations in
`content_final`. The durable `content` event and citation objects are committed
atomically; rejected or interrupted drafts are never exposed as provisional
assistant text.

| Class | Required event behavior |
| --- | --- |
| lifecycle | chat ID precedes dependent events; one atomic `content_final` stops live activity before persistence finishes; transcript version precedes `[DONE]`; one terminal outcome |
| text | no provisional prose events; accepted text and matching citations arrive together in `content_final`; durable `content` and citations commit together |
| reasoning/activity | reasoning deltas/blocks respect requested detail; tool start carries name and optional bounded input |
| input | `ask_inputs` pauses without a fake tool result; `ask_inputs_response` resumes the same logical turn |
| document | read/find, created, edited, download, automation, mutation receipt, version ID/number, and annotations remain source-bound |
| research | CourtListener, A2AJ, public source, citation, exact evidence, and provider-PDF events retain stable identities and locators |
| subagent | admission, running/completed/error state, assignment, result, sources, and parent aggregation are durable and restart-safe |
| error | public safe message, retained partial events, no local paths/credentials/provider internals |

`frontend/src/app/lib/sse.ts` is the one frame decoder and
`frontend/src/app/lib/assistantStreamEvents.ts` is the target reducer. The
tabular chat panel and any other consumer must use those rather than parse or
reconcile SSE independently.

## Durable state now in scope

| State | Current local representation | Current cloud representation | Target owner |
| --- | --- | --- | --- |
| documents, versions, folders, legal pointers | `library.sqlite` plus `files/` | Supabase documents/version/folder tables plus R2 | application metadata DB + `BlobStore` port |
| projects/matters and attachments | `legal-knowledge.sqlite` with reads into `library.sqlite` | Supabase project/member/folder/document tables | project tables in the application metadata contract |
| tabular reviews/cells | `tabular.sqlite` | Supabase tabular tables | tabular tables in the application metadata contract |
| chats/events | one JSON file per chat | Supabase chat/message rows | append-only chat/event tables in the application metadata contract |
| provider continuation | one JSON file per chat/provider | provider fields/session state | provider-session rows owned by chat persistence |
| derived PDF/SourceDoc/cache artifacts | files and small sidecar SQLite leases | object storage/cache where configured | versioned artifact helper; never authoritative state |
| A2AJ, CourtListener, journal, citator corpora | separate read-only `OpenLegalData` databases | external/provider data | remain outside application metadata |

Local schema consolidation must preserve the current developer data until an
explicit conversion command is authorized. Startup verifies schema; it does
not delete, silently migrate, or guess. Cloud service-role queries bypass RLS,
so owner/share/scope predicates are mandatory in the adapter and real-stack
contract tests.

## Proof matrix

The final `appContract(createDataPorts)` suite runs the same cases against:

- temporary SQLite and a temporary blob directory on every backend change;
- real local Supabase/Postgres and object storage in the integration lane; and
- small in-memory/fake provider boundaries for deterministic assistant turns.

Existing evidence to retain while the suite is assembled:

| Behavior | Current strongest checks |
| --- | --- |
| local document versions, cursor paging, folders, concurrency | `lib/__tests__/localDocumentStore.test.ts` |
| local project/document/chat continuity and isolation | `__tests__/integration/localMatter.routes.test.ts`, `routes/localChatEvidenceDurability.test.ts` |
| local tabular and workflow HTTP behavior | `__tests__/integration/localTabular.routes.test.ts`, `localWorkflows.routes.test.ts` |
| cloud projects, documents, chat, tabular, user routes | matching files under `__tests__/integration` |
| real service-role/RLS/schema behavior | `__tests__/integration/stack.supabase.test.ts`, `access.supabase.test.ts` |
| assistant transport/tool rounds and aborts | `__tests__/integration/liveToolLoop.test.ts`, chat/tool unit tests |
| local assistant reads, edits, receipts, evidence | `lib/__tests__/localAssistantTools.test.ts` and focused chat tool tests |
| frontend SSE reduction and retry/version behavior | `frontend/src/app/lib/assistantStreamEvents.test.ts`, `hooks/useAssistantChat.test.ts` |
| DOCX fidelity and mutation | `lib/__tests__/docx*.test.ts` fixtures and capability conformance |
| provider structure and exact locators | SourceDoc/provider fixture and corpus-audit tests |

Tests that assert only an import, branch, mock call chain, CSS class, or exact
non-contract copy do not block deletion. Before deleting a path, map each real
invariant above to a shared test. A slice is incomplete if either adapter has a
separate behavior test instead of joining the parameterized contract.

## Slice gate

Every contraction commit records:

- contract rows affected and shared tests proving them;
- old files/functions removed and all callers moved;
- local and cloud adapter results where persistence changed;
- production and total authored line deltas from `npm run measure:source`;
- affected cold/warm timing, including first use; and
- focused tests plus the applicable full build/test lane.

No slice lands a second runtime, temporary compatibility path, feature flag,
or adapter-specific DTO. Git is the rollback mechanism.

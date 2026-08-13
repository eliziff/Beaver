# Beaver scalable collections plan

Status: implemented; release validation in progress
Scope: projects, custom workflows, tabular reviews, Library documents, and project documents
Principle: one bounded contract in local and cloud modes; no parallel legacy API

## Decision

Replace Beaver's unbounded collection reads with server-filtered keyset pages.
Keep fixed system workflows separate because that catalogue is small and shipped
with the application. Move local Library metadata from one rewritten JSON file
to SQLite, and index filename substring search with FTS5 trigrams. Use the same
wire contract and search semantics in local and cloud modes.

Do not port Mike's pagination branch. Its useful idea is bounded reads, but its
offset pages, unpaginated sibling routes, resource-specific frontend state, and
separate "all matching IDs" queries produce too much code and duplicate access
and filter predicates.

## The present failure mode

The current screens look bounded because their tables scroll, but their data
paths are not bounded:

- `GET /projects`, `GET /workflows`, and `GET /tabular-review` return every
  visible row. Search and scope filters run in the browser.
- Project responses can embed every document and folder. The project overview
  also computes file, chat, and review counts for every visible project.
- Library and project directories load the complete document/folder tree before
  rendering, searching, selecting, moving, or deleting anything.
- Several local assistant and document routes call `listLocalLibrary()` merely
  to find one document or build a small inventory. Pagination only at the HTTP
  boundary would leave those whole-store reads intact.
- Local Library metadata is read from `library.json` as a single object and the
  entire file is rewritten after every mutation.

With enough records, first load, browser memory, prompt size, and local writes
all grow with the collection. This plan removes those dependencies rather than
placing a paginated facade over them.

## Contract

All growing list routes return:

```ts
type Page<T> = {
  items: T[];
  next_cursor: string | null;
};
```

Common query parameters:

- `limit`: default 50, maximum 200.
- `cursor`: absent on the first request.
- `q`: optional case-insensitive substring search.
- Resource filters such as project scope, workflow type, `project_id`, and
  directory `parent_id` remain explicit query parameters.

The server fetches `limit + 1` rows, returns at most `limit`, and derives the
next cursor from the last returned row. There is no collection total. A total
would add a second potentially expensive query without helping the user load
the next page.

### Cursor

Use one small backend helper to encode and decode base64url JSON containing:

```ts
{
  v: 1,
  resource: string,
  filters: object,
  after: unknown[]
}
```

The decoder enforces a short maximum encoded length, an exact schema, the
expected resource, normalized filters, and the expected sort tuple. Malformed,
cross-resource, or filter-mismatched cursors return `400`.

The cursor is intentionally unsigned. It is a position, not a grant. Every
page query reapplies authentication, ownership/sharing rules, and filters; a
caller who changes a cursor can only choose a different position among rows
they are already allowed to read. Signing would add a secret and rotation
problem without protecting data.

Projects and tabular reviews use `(created_at DESC, id DESC)`. Custom workflows
use the same tuple. Directory browsing uses folders first, then
`(lower(name), id)` within each kind; filename search uses
`(lower(filename), id)`. The final ID makes every order total and deterministic.
Renames invalidate the affected directory page so the browser reloads it in
the correct position.

### Routes and response shapes

| Route | Result | Notes |
| --- | --- | --- |
| `GET /projects` | `Page<ProjectSummary>` | Server-side `q` and `scope`; no embedded documents, folders, chats, or reviews. |
| `GET /projects/:id` | `ProjectDetail` | Project fields only. Related collections have their own routes. |
| `GET /projects/:id/directory` | `Page<DirectoryEntry>` | Immediate children for `parent_id`; flat document results when `q` is present. |
| `GET /workflows/system` | `SystemWorkflow[]` | Fixed repository catalogue; bounded by the application, not user data. |
| `GET /workflows` | `Page<WorkflowSummary>` | Custom owned/shared workflows only. |
| `GET /workflows/:id` | `WorkflowDetail` | Loads prompt and column configuration only when needed. |
| `GET /tabular-review` | `Page<TabularReviewSummary>` | Server-side `q` and optional `project_id`. |
| `GET /tabular-review/:id` | `TabularReviewDetail` | Existing full review path. Large cell grids are a separate concern. |
| `GET /library/:kind` | `Page<DirectoryEntry>` | Immediate children for `parent_id`; flat document results for search. |
| `GET /single-documents` | `Page<DocumentSummary>` | Same document query, without folders. |

`ProjectSummary` contains project identity, ownership/sharing display fields,
practice, and dates. Remove the file/chat/review counters from the project list:
they are decorative, force cross-store work in local mode, and are unnecessary
to find or open a project. Do not build a chat index solely to retain them.

`WorkflowSummary` omits `skill_md` and the full columns configuration.
`TabularReviewSummary` includes `document_count`, `column_count`, and
`project_name`, but omits `document_ids`, cells, and `columns_config`.
`DirectoryEntry` is a discriminated folder/document summary and never exposes
storage paths. Existing detail and display routes remain the authority for
content and download access.

Remove `include=documents`, embedded project collections, and the old array
responses. All callers change in the same implementation. There is no second
contract to maintain.

## Query design

### Cloud/Supabase

Replace the three overview RPCs with page RPCs and add page queries for the two
directory surfaces. Each RPC must:

1. Establish the visible and filtered row set once.
2. Apply the keyset predicate and `limit + 1` to that set.
3. Join display metadata or per-row summary counts only for that page.
4. Return rows to the backend, which creates the cursor.

The server Supabase client uses the service role, so explicit owner/share
predicates remain mandatory in every RPC. Cursor validation does not replace
authorization. Access tests must attempt cross-user cursor reuse.

Use `EXISTS` for sharing predicates rather than owner/shared `UNION` branches;
one workflow or project must produce one row even if several share records
match. Do not create a second ID-only query for bulk selection. Bulk requests
carry the explicit IDs selected in the browser and recheck access server-side.

Add composite B-tree indexes matching access/filter and keyset order. Enable
`pg_trgm` and add GIN trigram indexes for the exact expressions used by
case-insensitive substring search. Confirm each search and page query with
`EXPLAIN (ANALYZE, BUFFERS)` on seeded large tables; an index existing in the
schema is not evidence that the query uses it.

### Local SQLite

Keep local projects in `legal-knowledge.sqlite` and tabular reviews in
`tabular.sqlite`; add page methods and matching `(scope, created_at, id)`
indexes to their existing stores. Local custom workflows return an empty page;
the fixed system catalogue remains fully available.

Store local Library metadata in `library.sqlite` tables for:

- documents, versions, and their versioned file metadata;
- Library folders;
- legal-source references and their current local metadata.

The document bytes and parse artifacts stay at their existing paths. Enable
foreign keys, WAL, and a busy timeout. Index owner/kind/folder/order, document
version lookup, and folder ancestry. Keep project/document membership in the
legal-knowledge store; its page query attaches `library.sqlite` and performs a
read-only join from the association to current document metadata. This
preserves module ownership without copying document rows into a second
database.

Create a normal FTS5 trigram table for version filenames and synchronize it
with insert/update/delete triggers in the same transaction as version metadata.
Search of three or more characters uses FTS to find candidates and an `instr`
check to preserve literal substring semantics. One- and two-character searches
use the same `instr` predicate directly. These are two defined query plans with
identical results; the UI does not weaken or redefine short searches.

Why FTS here: on the available Node/SQLite runtime, a synthetic 100,000-name
probe measured a median 12.94 ms full substring scan and 0.04 ms trigram match.
The corresponding database grew from about 5.6 MB to 17.2 MB and bulk insertion
was about 3.3 times slower. That storage/write cost is justified for the
largest searched collection—document filenames—but not yet for small local
project or review tables. Their ordinary scans must be benchmarked before an
additional FTS table is added.

There is no JSON compatibility path. Beaver has no deployed users, so the
SQLite store is the only local contract and starts clean.

## Remove hidden whole-collection reads

The store API must provide exact and bounded operations:

- `getDocument(userId, documentId)` and `getDocumentsById(...)`;
- `pageDirectory(...)` and `pageProjectDirectory(...)`;
- `searchDocuments(...)`;
- `countDocuments(...)` where a count is actually required.

Delete the production `listLocalLibrary()` path after its callers move. In
particular:

- membership checks in local Library routes use an exact document lookup;
- assistant tools resolving supplied IDs use `getDocumentsById`;
- the Library list/search tool accepts `q`, `limit`, and `cursor` and uses the
  same store query as the UI;
- an explicitly scoped chat loads those document IDs only;
- an unscoped chat prompt uses a count and at most eight recent names, while
  the model can search further through the bounded Library tool;
- exports and account cleanup iterate database pages or issue set-based SQL
  rather than first materializing every metadata row.

An acceptance grep should find no production code that loads all Library
metadata in order to find, validate, count, or name a subset.

## Frontend

Add one small `usePagedQuery<T>` state helper. It owns `items`, `nextCursor`,
loading/error state, reset, and append. Resource components retain their own
filters and rendering; do not create one abstraction per collection.

- Send search and scope changes to the server after a short debounce and abort
  obsolete requests.
- Render an explicit **Load more** control. Fetch future pages only on user
  demand; do not prefetch the complete collection.
- Header selection applies to loaded visible rows only and says so in its
  accessible label. Changing a filter clears selection. Bulk actions send
  those explicit IDs.
- Project choosers, document pickers, new-review document selection, and the
  workflow picker use the same paged queries instead of loading all records in
  a modal.
- If a modal's current selection is outside the loaded page, fetch that item by
  ID and show it without loading the intervening pages.
- Fetch workflow detail when a workflow is selected for preview. Fetch project
  documents from the directory route rather than from project detail.
- New tabular reviews start from explicitly selected document IDs. They do not
  silently select every document in a project.

### Paged directory rules

Cache one page chain per `(collection, parent_id, q)`. Expanding a folder loads
that folder's immediate children. Search is a flat server result and does not
require expanding the tree.

The current tree has behaviours that become incorrect when only part of it is
loaded. Change them deliberately:

- Folder-to-chat drag is removed. A folder can contain unloaded descendants,
  so serializing the visible subset as the whole folder would be wrong.
  Individual document drag remains.
- Folder move validation is authoritative on the server. The client may reject
  an obvious cycle among loaded ancestors, but the database checks the complete
  ancestry before committing.
- Folder deletion confirmation says that the folder and its contents will be
  deleted; it does not calculate a partial descendant count in the browser.
  The server performs the recursive operation, and the client reloads the
  affected parent.
- Create, rename, move, upload, and delete reload only the affected parent page
  chains. They never patch an assumed complete tree.

## Implementation sequence

1. **Contract and cursor** — add shared page types, strict cursor parsing, and
   contract tests. Change API client types before any screen keeps using the
   old arrays.
2. **Local Library store** — add the SQLite schema, exact lookups, page/search
   queries, and FTS integrity tests. Convert every internal caller and remove
   the JSON runtime store.
3. **Backend pages** — implement local project/tabular pages and cloud page
   RPCs, directory routes, summaries, indexes, and authorization tests. Remove
   the old overview RPCs and `include=documents` path.
4. **Frontend consumers** — add the one page helper; convert overview screens,
   pickers, workflow preview, and directories; apply the loaded-selection and
   directory mutation rules above.
5. **Delete obsolete code** — remove browser-wide filtering, embedded related
   collections, full-tree utilities that claim global knowledge, old response
   types, and unused RPCs. Do not retain adapters for the previous contract.
6. **Scale proof and release checks** — run the matrices below, then the normal
   Beaver release checks.

Steps may be separate commits, but the branch is not ready to merge until the
old contract and whole-collection runtime paths are gone.

## Adversarial test matrix

### Contract and cursor

- Empty, one-row, exact-page, and multi-page collections.
- Invalid base64, oversized token, wrong version/resource/tuple, and changed
  filter with an old cursor all return `400`.
- Every row appears once across an unchanged collection.
- A newer insertion between requests does not shift later pages; deletion does
  not create an offset skip.
- Reusing another user's valid cursor never returns that user's rows.

### Local storage and search

- Create, rename/version, switch current version, move, and delete keep FTS and
  relational results synchronized.
- For punctuation, quotes, `%`, `_`, Unicode, mixed case, and one-, two-, and
  three-character queries, indexed results equal a literal brute-force oracle.
- Restart after each mutation and confirm the same page/detail results.

### UI behaviour

- Load more, filter reset, request cancellation, empty pages, and retry.
- Select loaded rows, change search/scope, and verify no stale bulk selection.
- Expand separately paged nested folders; rename/move/delete across parents;
  verify the reloaded tree and server cycle rejection.
- Project, workflow, and document picker selections continue to work when the
  desired item is beyond the first page.
- Keyboard, focus, status announcements, 320 CSS pixels, and 200% zoom remain
  usable for every changed surface.

### Scale and query plans

Seed both modes with at least 10,000 projects, 10,000 custom workflows, 10,000
tabular reviews, 100,000 documents, nested folders, and shared rows. Record:

- first-page and search latency;
- response bytes and browser heap for the first page;
- SQL statement count per request;
- `EXPLAIN` output showing the expected keyset and trigram/FTS indexes;
- local startup time and the cost of one document metadata mutation.

The pass condition is structural, not a machine-specific millisecond target:
response size and rows materialized are bounded by the requested page, request
query count is constant, ordinary page queries do not use large offsets, local
startup does not scan collection metadata, and a metadata mutation does not
rewrite the collection.

Run the repository release checks last:

```powershell
npm test --prefix backend
npm test --prefix frontend
npm run build --prefix backend
npm run build --prefix frontend
.\scripts\mike.ps1 smoke -WithTableOfAuthorities
```

## Explicit non-goals

- Paginating the fixed system-workflow catalogue.
- A generic repository/query framework.
- A second ID-only selection API or global "select all matching" action.
- Snapshot isolation across a user's concurrent renames, access changes, or
  deletions; each request reflects current authorization and data.
- Pagination of cells inside one exceptionally large tabular review. Address
  that only when a real large-review workload requires it.
- Local project folders. Local projects remain a flat paged document
  collection until that product capability is designed on its own merits.

## Research basis

- [Google AIP-158: Pagination](https://google.aip.dev/158) — opaque page tokens,
  stable request parameters, bounded page size, and authorization on every
  request.
- [Google AIP-4233: Page streaming](https://google.aip.dev/client-libraries/4233)
  — retrieve later pages on demand rather than greedily.
- [PostgreSQL `LIMIT` and `OFFSET`](https://www.postgresql.org/docs/current/queries-limit.html)
  — deterministic ordering is required and large offsets can be inefficient.
- [PostgreSQL `pg_trgm`](https://www.postgresql.org/docs/17/pgtrgm.html) — GIN
  and GiST support for indexed `LIKE`/`ILIKE` substring searches.
- [SQLite FTS5 trigram tokenizer](https://www.sqlite.org/fts5.html) — indexed
  substring matching and the short-pattern limitation addressed above.
- [Microsoft Graph drive children](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-beta)
  — page immediate children of a hierarchy rather than transferring the full
  tree.

# Collection reuse

Projects, Library files/templates, project directories, their shared file/project
pickers, and tabular-review collections opt into the same paged-collection engine.
Other users of `usePagedChains` remain component-local, including Sources' manually
loaded, revision-sensitive passage/finding chains.

## Identity and lifetime

`collectionKeys.ts` gives each reusable collection an explicit identity, including
resource, project/library scope, query, filters and page size. Each entry owns its
folder/page cursor chains. The cache lives inside an account-keyed provider under
AuthProvider, so account changes unmount consumers and discard their cache. It uses
no localStorage, IndexedDB, response cache, or persisted private data.

Inactive retention is bounded to 32 entries, 8,000 items and an estimated 8 MiB of
serialized UTF-16 data. Entries older than five idle minutes are discarded on reuse
or retention maintenance. Active views are not evicted. This is an inactive-cache
budget, not a limit on the application's total memory. Large active collections can
exceed it; their cache is discarded when they become inactive.

## Freshness

Returning to a collection synchronously renders the retained snapshot and starts
revalidation. There is deliberately no multi-minute "fresh enough" interval that
skips this read. Simultaneously mounted identical views share both state and
in-flight requests. Pagination reloads rebuild the loaded depth before atomically
replacing the snapshot; old and new cursor generations are never concatenated.

Successful API mutations invalidate affected collection identities, including
inactive queries. A pending pre-mutation read is aborted and cannot restore deleted
or superseded rows even when the transport ignores its abort signal. Inactive
invalidated entries are cleared rather than displayed on the next visit. Active
entries revalidate; existing component mutation callbacks can update their shared
rows immediately. Version/permission checks on subsequent operations remain on the
server.

Focus, visibility restoration, and reconnect revalidate active entries. Same-origin
tabs exchange invalidation identities only, scoped by account, using BroadcastChannel
when available. They never exchange rows or documents. There is no server-side push
subscription in this PR: external changes in an already-focused view become visible
on its next explicit refresh, activation, mutation, focus, or reconnect. A 401 clears
all retained collection scopes; 403/404 discard the affected resource's queries.
Transient revalidation failures retain their data in the store and expose the error
to the consumer; individual screens keep their existing error presentation.

Chat history no longer reloads on every pathname change. Its existing local updates,
explicit refreshes and turn-completion refreshes remain, supplemented by mutation,
focus, visibility and online listeners. Local mutation results supersede outstanding
history-list requests.

## Validation

`frontend/src/app/hooks/collectionReuse.test.tsx` exercises shared requests, actual
consumer unmount/remount, account replacement, late responses, inactive invalidation,
loaded depth, empty lists, access failures, recovery, retention and StrictMode. Existing
Sources and collection interaction tests exercise the private/manual hook contract.

After building the frontend and installing the repository's locked Playwright tools:

```sh
node scripts/test-collection-reuse.mjs frontend/dist /path/to/baseline/dist .perf/collections
```

The browser probe uses production UI and an isolated loopback fixture server. It holds
revalidation responses indefinitely to prove that retained rows, including a second
page, are usable before the network completes. It also checks refresh replacement,
empty-filter return, actual project deletion, and unrelated chat-history request counts.
It is not an end-to-end cloud latency or first-ever cold-start benchmark.

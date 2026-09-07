# Intent-driven navigation prefetch

Pointer entry (except touch) or keyboard focus on supported navigation links starts the destination's existing lazy route import and first collection-page request. Supported destinations are Projects, Library files/templates and individual project directories. It does not scan links on render, prefetch every document, call models, mutate state on the server, or guess Sources' manually controlled revision-sensitive queries.

The hook requires an account-owned collection context and respects offline, Save-Data and 2G connection hints. The existing collection cache limits speculative reads to two simultaneously and discards excess hover work rather than queuing a backlog. Speculative results use the same query/scope identities, mutation invalidation, permission failure handling, session ownership and retention budgets as ordinary collection reads.

Navigation joins an in-flight speculative read. A completed speculative read can be handed off once, within one second, without an immediate duplicate request; this is not a general stale-data TTL. Returning later still revalidates. Mutations clear the handoff. Failed speculative reads are retried by actual navigation. Clearing an old account's collection store prevents its late results from repopulating it. Route imports are configuration-independent and actual navigation retains responsibility for showing route errors.

## Focused checks

```sh
cd frontend
npx vitest run src/app/hooks/navigationPrefetch.test.tsx src/app/hooks/collectionReuse.test.tsx src/app/hooks/collectionIdentity.test.tsx src/app/components/shared/AppSidebar.test.tsx
npx tsc --noEmit
npx vite build
cd ..
npx playwright install chromium
CHECK_NAVIGATION_PREFETCH=1 node scripts/test-collection-reuse.mjs frontend/dist '' .perf/navigation
```

The production-UI probe starts on Library in a fresh browser. Pointer and keyboard cases demonstrate a Projects request beginning while still on Library, then handing off/joining that single request when navigating. It also retains the existing two-page return-navigation, refresh, empty-filter and deletion checks. The fixture supplies current ontology/membership API shapes without loading user data. No full application battery is needed.

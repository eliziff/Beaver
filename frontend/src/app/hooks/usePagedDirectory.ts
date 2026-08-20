import { useCallback, useMemo } from "react";
import type { DirectoryEntry, Page } from "@/app/lib/beaverApi";
import { usePagedChains } from "./usePagedChains";

const keyFor = (parentId: string | null, q: string) =>
    q ? "search" : parentId ?? "root";

export function usePagedDirectory(
    load: (
        parentId: string | null,
        q: string,
        cursor: string | null,
        signal: AbortSignal,
    ) => Promise<Page<DirectoryEntry>>,
    q: string,
    dependencies: readonly unknown[],
    enabled = true,
) {
    const query = q.trim();
    const rootKey = keyFor(null, query);
    const { chains, fetchPage } = usePagedChains(
        (key, cursor, signal) => load(
            key === "root" || key === "search" ? null : key,
            query,
            cursor,
            signal,
        ),
        dependencies,
        rootKey,
        enabled,
    );

    const ensureParent = useCallback((parentId: string | null) => {
        const key = keyFor(parentId, query);
        if (!chains[key]) void fetchPage(key, null, false);
    }, [chains, fetchPage, query]);
    const loadMore = useCallback((parentId: string | null) => {
        const key = keyFor(parentId, query);
        const chain = chains[key];
        if (chain?.nextCursor && !chain.loading) {
            void fetchPage(key, chain.nextCursor, true);
        }
    }, [chains, fetchPage, query]);
    const reload = useCallback((parentId: string | null = null) =>
        fetchPage(keyFor(parentId, query), null, false), [fetchPage, query]);
    const derived = useMemo(() => {
        const activeChains = query
            ? [chains.search].filter((chain) => chain !== undefined)
            : Object.values(chains);
        const seen = new Set<string>();
        const items = activeChains.flatMap((chain) => chain.items).filter((item) => {
            const key = `${item.kind}:${item.kind === "folder"
                ? item.folder.id : item.document.id}`;
            return !seen.has(key) && !!seen.add(key);
        });
        const documents = items.flatMap((item) =>
            item.kind === "document" ? [item.document] : []);
        const folders = items.flatMap((item) =>
            item.kind === "folder" ? [item.folder] : []);
        const hasMoreParents = new Set<string | null>();
        const loadingParents = new Set<string | null>();
        for (const [key, chain] of Object.entries(chains)) {
            const parentId = key === "root" || key === "search" ? null : key;
            if (chain.nextCursor) hasMoreParents.add(parentId);
            if (chain.loading) loadingParents.add(parentId);
        }
        return { items, documents, folders, hasMoreParents, loadingParents };
    }, [chains, query]);

    return {
        ...derived,
        loading: chains[keyFor(null, query)]?.loading ?? enabled,
        ensureParent,
        loadMore,
        reload,
    };
}

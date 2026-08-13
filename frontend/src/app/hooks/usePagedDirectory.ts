"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DirectoryEntry, Page } from "@/app/lib/beaverApi";

type Chain = {
    items: DirectoryEntry[];
    nextCursor: string | null;
    loading: boolean;
};

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
    const [chains, setChains] = useState<Record<string, Chain>>({});
    const requests = useRef(new Map<string, AbortController>());

    const fetchPage = useCallback(async (
        parentId: string | null,
        cursor: string | null,
        append: boolean,
    ) => {
        const key = keyFor(parentId, query);
        requests.current.get(key)?.abort();
        const controller = new AbortController();
        requests.current.set(key, controller);
        setChains((current) => ({
            ...current,
            [key]: {
                items: append ? current[key]?.items ?? [] : [],
                nextCursor: append ? current[key]?.nextCursor ?? null : null,
                loading: true,
            },
        }));
        try {
            const page = await load(parentId, query, cursor, controller.signal);
            if (controller.signal.aborted) return;
            setChains((current) => ({
                ...current,
                [key]: {
                    items: append
                        ? [...(current[key]?.items ?? []), ...page.items]
                        : page.items,
                    nextCursor: page.next_cursor,
                    loading: false,
                },
            }));
        } catch (error) {
            if (!controller.signal.aborted) {
                setChains((current) => ({
                    ...current,
                    [key]: {
                        ...(current[key] ?? { items: [], nextCursor: null }),
                        loading: false,
                    },
                }));
                console.error("[directory] failed to load", error);
            }
        }
    }, dependencies); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        for (const request of requests.current.values()) request.abort();
        setChains({});
        if (enabled) void fetchPage(null, null, false);
        return () => {
            for (const request of requests.current.values()) request.abort();
        };
    }, [enabled, fetchPage]);

    const ensureParent = useCallback((parentId: string | null) => {
        const key = keyFor(parentId, query);
        if (!chains[key]) void fetchPage(parentId, null, false);
    }, [chains, fetchPage, query]);
    const loadMore = useCallback((parentId: string | null) => {
        const chain = chains[keyFor(parentId, query)];
        if (chain?.nextCursor && !chain.loading) {
            void fetchPage(parentId, chain.nextCursor, true);
        }
    }, [chains, fetchPage, query]);
    const reload = useCallback((parentId: string | null = null) =>
        fetchPage(parentId, null, false), [fetchPage]);
    const activeChains = query
        ? [chains.search].filter((chain): chain is Chain => !!chain)
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

    return {
        items,
        documents,
        folders,
        loading: chains[keyFor(null, query)]?.loading ?? enabled,
        hasMoreParents,
        loadingParents,
        ensureParent,
        loadMore,
        reload,
    };
}

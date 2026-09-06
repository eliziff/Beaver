import { useCallback } from "react";
import type { CollectionSpec } from "@/app/lib/collections";
import type { Page } from "@/app/lib/api/client";
import { usePagedChains } from "./usePagedChains";

export function usePagedQuery<T>(
  load: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  dependencies: readonly unknown[],
  enabled = true,
  collection?: CollectionSpec,
) {
  const key = "query";
  const { chains, setChains, fetchPage } = usePagedChains(
    (_key, cursor, signal) => load(cursor, signal),
    dependencies,
    key,
    enabled,
    undefined,
    collection,
  );
  const chain = chains[key];
  const reload = useCallback(() => fetchPage(key, null, false, true), [fetchPage]);
  const setItems = useCallback((update: T[] | ((current: T[]) => T[])) => {
    setChains((current) => ({ ...current, [key]: {
      ...(current[key] ?? { nextCursor: null, loading: false, error: null }),
      items: typeof update === "function"
        ? update(current[key]?.items ?? []) : update,
    } }));
  }, [setChains]);

  return {
    items: chain?.items ?? [],
    loading: chain ? chain.loading && !chain.refreshing : enabled,
    error: chain?.error ?? null,
    refreshing: !!chain?.loading && !!chain?.loaded,
    loaded: !!chain?.loaded,
    hasMore: chain?.nextCursor != null,
    loadMore: () => chain?.nextCursor && !chain.loading && fetchPage(key, chain.nextCursor, true),
    reload,
    setItems,
  };
}

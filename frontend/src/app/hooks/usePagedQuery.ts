import { useCallback, useState } from "react";
import type { CollectionSpec } from "@/app/lib/collections";
import type { Page } from "@/app/lib/api/client";
import { usePagedChains } from "./usePagedChains";

export function usePagedQuery<T>(
  load: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  dependencies: readonly unknown[],
  enabled = true,
  collection?: CollectionSpec,
  // Opt in only within one account/resource/filter scope; the query may change.
  retention?: { scope: string; query: string },
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
  // The last loaded items within the retention scope, shown while a new query loads.
  const [previous, setPrevious] = useState<{ scope: string; query: string; items: T[] } | null>(null);
  const kept = enabled && retention && !chain?.error
    ? chain?.loaded ? { ...retention, items: chain.items } : previous?.scope === retention.scope ? previous : null
    : null;
  if (kept?.items !== previous?.items || kept?.query !== previous?.query || kept?.scope !== previous?.scope) setPrevious(kept);
  const retained = chain?.loaded ? null : kept;
  const loadMore = useCallback(() => chain?.nextCursor && !chain.loading && fetchPage(key, chain.nextCursor, true), [chain, fetchPage]);
  const reload = useCallback(() => fetchPage(key, null, false, true), [fetchPage]);
  const setItems = useCallback((update: T[] | ((current: T[]) => T[])) => {
    setChains((current) => ({ ...current, [key]: {
      ...(current[key] ?? { nextCursor: null, loading: false, error: null }),
      items: typeof update === "function"
        ? update(current[key]?.items ?? []) : update,
    } }));
  }, [setChains]);

  return {
    items: retained?.items ?? chain?.items ?? [],
    displayQuery: retained?.query ?? retention?.query,
    loading: chain ? chain.loading && !chain.refreshing : enabled,
    error: chain?.error ?? null,
    refreshing: !!chain?.loading && !!chain?.loaded,
    loaded: !!chain?.loaded,
    hasMore: chain?.nextCursor != null,
    loadMore,
    reload,
    setItems,
  };
}

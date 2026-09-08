import { useCallback, useLayoutEffect, useRef } from "react";
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
  const previous = useRef<{ scope: string; query: string; items: T[] } | null>(null);
  const retained = enabled && retention && !chain?.loaded && !chain?.error && previous.current?.scope === retention.scope
    ? previous.current : null;
  useLayoutEffect(() => {
    if (!enabled || !retention || chain?.error || previous.current?.scope !== retention.scope) previous.current = null;
    if (enabled && retention && chain?.loaded && !chain.error)
      previous.current = { ...retention, items: chain.items };
  }, [enabled, retention?.scope, retention?.query, chain]); // eslint-disable-line react-hooks/exhaustive-deps
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

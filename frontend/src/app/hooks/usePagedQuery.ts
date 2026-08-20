import { useCallback } from "react";
import type { Page } from "@/app/lib/beaverApi";
import { usePagedChains } from "./usePagedChains";

export function usePagedQuery<T>(
  load: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  dependencies: readonly unknown[],
  enabled = true,
) {
  const key = "query";
  const { chains, setChains, fetchPage } = usePagedChains(
    (_key, cursor, signal) => load(cursor, signal),
    dependencies,
    key,
    enabled,
  );
  const chain = chains[key];
  const setItems = useCallback((update: T[] | ((current: T[]) => T[])) => {
    setChains((current) => ({ ...current, [key]: {
      ...(current[key] ?? { nextCursor: null, loading: false, error: null }),
      items: typeof update === "function"
        ? update(current[key]?.items ?? []) : update,
    } }));
  }, [setChains]);

  return {
    items: chain?.items ?? [],
    loading: chain?.loading ?? enabled,
    error: chain?.error ?? null,
    hasMore: chain?.nextCursor != null,
    loadMore: () => chain?.nextCursor && fetchPage(key, chain.nextCursor, true),
    reload: () => fetchPage(key, null, false),
    setItems,
  };
}

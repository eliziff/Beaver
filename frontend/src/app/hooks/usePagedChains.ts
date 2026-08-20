import { useCallback, useEffect, useRef, useState } from "react";
import type { Page } from "@/app/lib/beaverApi";

type PageChain<T> = { items: T[]; nextCursor: string | null; loading: boolean; error: unknown };

export function usePagedChains<T>(
  load: (key: string, cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  dependencies: readonly unknown[],
  initialKey: string,
  enabled: boolean,
) {
  const [chains, setChains] = useState<Record<string, PageChain<T>>>({});
  const requests = useRef(new Map<string, AbortController>());
  const fetchPage = useCallback(async (
    key: string, cursor: string | null, append: boolean,
  ) => {
    requests.current.get(key)?.abort();
    const controller = new AbortController();
    requests.current.set(key, controller);
    setChains((current) => ({ ...current, [key]: {
      items: append ? current[key]?.items ?? [] : [],
      nextCursor: append ? current[key]?.nextCursor ?? null : null,
      loading: true, error: null,
    } }));
    try {
      const page = await load(key, cursor, controller.signal);
      if (controller.signal.aborted) return;
      setChains((current) => ({ ...current, [key]: {
        items: append ? [...(current[key]?.items ?? []), ...page.items] : page.items,
        nextCursor: page.next_cursor, loading: false, error: null,
      } }));
    } catch (error) {
      if (!controller.signal.aborted) setChains((current) => ({ ...current,
        [key]: { ...(current[key] ?? { items: [], nextCursor: null }),
          loading: false, error },
      }));
    }
  }, dependencies); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    for (const request of requests.current.values()) request.abort();
    setChains({});
    if (enabled) void fetchPage(initialKey, null, false);
    return () => requests.current.forEach((request) => request.abort());
  }, [enabled, fetchPage, initialKey]);

  return { chains, setChains, fetchPage };
}

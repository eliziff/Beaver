import { useCallback, useEffect, useRef, useState } from "react";
import type { Page } from "@/app/lib/api/client";

type PageChain<T> = { items: T[]; nextCursor: string | null; loading: boolean; error: unknown; revision?: string };

export function usePagedChains<T>(
  load: (key: string, cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  dependencies: readonly unknown[],
  initialKey: string,
  enabled: boolean,
  revisions?: Readonly<Record<string, string>>,
) {
  const [chains, setChains] = useState<Record<string, PageChain<T>>>({});
  const latest = useRef({ chains, revisions });
  latest.current = { chains, revisions };
  const requests = useRef(new Map<string, AbortController>());
  const fetchPage = useCallback(async (
    key: string, cursor: string | null, append: boolean,
  ) => {
    requests.current.get(key)?.abort();
    const controller = new AbortController();
    requests.current.set(key, controller);
    const revision = latest.current.revisions?.[key],
      retainCount = !append && latest.current.revisions ? latest.current.chains[key]?.items.length ?? 0 : 0;
    setChains((current) => ({ ...current, [key]: {
      items: current[key]?.items ?? [],
      nextCursor: current[key]?.nextCursor ?? null,
      loading: true, error: null, revision,
    } }));
    try {
      let page = await load(key, cursor, controller.signal);
      const items = [...page.items];
      while (!controller.signal.aborted && page.next_cursor && items.length < retainCount) {
        page = await load(key, page.next_cursor, controller.signal);
        items.push(...page.items);
      }
      if (controller.signal.aborted) return;
      setChains((current) => ({ ...current, [key]: {
        items: append ? [...(current[key]?.items ?? []), ...items] : items,
        nextCursor: page.next_cursor, loading: false, error: null, revision,
      } }));
    } catch (error) {
      if (!controller.signal.aborted) setChains((current) => ({ ...current,
        [key]: { ...(current[key] ?? { items: [], nextCursor: null }),
          loading: false, error },
      }));
    } finally {
      if (requests.current.get(key) === controller) requests.current.delete(key);
    }
  }, dependencies); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const activeRequests = requests.current;
    for (const request of activeRequests.values()) request.abort();
    setChains({});
    if (enabled) void fetchPage(initialKey, null, false);
    return () => activeRequests.forEach((request) => request.abort());
  }, [enabled, fetchPage, initialKey]);

  useEffect(() => {
    if (!revisions) return;
    for (const [key, chain] of Object.entries(chains))
      if (key in revisions && chain.revision !== revisions[key]) void fetchPage(key, null, false);
  }, [chains, revisions, fetchPage]);

  return { chains, setChains, fetchPage };
}

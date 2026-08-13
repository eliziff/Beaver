"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Page } from "@/app/lib/beaverApi";

export function usePagedQuery<T>(
  load: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  dependencies: readonly unknown[],
  enabled = true,
) {
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<unknown>(null);
  const request = useRef<AbortController | null>(null);

  const fetchPage = useCallback(async (cursor: string | null, append: boolean) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const page = await load(cursor, controller.signal);
      if (controller.signal.aborted) return;
      setItems((current) => append ? [...current, ...page.items] : page.items);
      setNextCursor(page.next_cursor);
    } catch (nextError) {
      if (!controller.signal.aborted) setError(nextError);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, dependencies); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (enabled) void fetchPage(null, false);
    else {
      request.current?.abort();
      setItems([]);
      setNextCursor(null);
      setLoading(false);
      setError(null);
    }
    return () => request.current?.abort();
  }, [enabled, fetchPage]);

  return {
    items,
    loading,
    error,
    hasMore: nextCursor !== null,
    loadMore: () => nextCursor && fetchPage(nextCursor, true),
    reload: () => fetchPage(null, false),
    setItems,
  };
}

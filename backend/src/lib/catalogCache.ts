import { bufferRemoteResponse } from "./remoteUrlSafety";

export async function fetchCatalogJson<T>(url: string, { label, timeoutMs, headers, maxBytes = 1024 * 1024 }: {
  label: string; timeoutMs: number; headers?: Record<string, string>; maxBytes?: number;
}): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} failed (HTTP ${response.status}).`);
  }
  return await (await bufferRemoteResponse(response, {
    label, maxBytes, contentTypes: ["application/json"],
  })).json() as T;
}

/**
 * Stale-while-revalidate cache for a provider model catalog: `snapshot` answers
 * from the last known catalog and refreshes in the background, so a slow,
 * throttled, or absent provider never delays a request. `ttlMs` overrides the
 * shared interval for sources whose catalogue changes slowly and is expensive.
 */
export function createCatalogCache<T extends { source: "live" | "unavailable" }, I = void>(
  probe: (input: I) => Promise<T>, empty: T, options?: { ttlMs?: number },
) {
  const ttlMs = options?.ttlMs ?? 300_000;
  let known: T | undefined, checkedAt = 0, checkedLive = false, inflight: Promise<T> | null = null;
  // A probe that fails (or answers `unavailable`) is retried after a short
  // backoff, not trusted for the whole TTL: one slow boot under load must not
  // pin the catalogue to its fallback for hours.
  const stale = () => Date.now() - checkedAt > (checkedLive ? ttlMs : 30_000);
  const refresh = (input: I) => {
    checkedAt = Date.now();
    return inflight ??= probe(input)
      .then((value) => { known = value; checkedLive = value.source === "live"; return value; })
      .catch(() => {
        const value = { ...(known ?? empty), source: "unavailable" as const } as T;
        known = value; checkedLive = false;
        return value;
      })
      .finally(() => { inflight = null; });
  };
  return {
    snapshot: (input: I): T => { if (stale()) void refresh(input); return known ?? empty; },
    resolve: (input: I) => stale() ? refresh(input) : Promise.resolve(known ?? empty),
  };
}

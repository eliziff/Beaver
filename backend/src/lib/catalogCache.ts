import { bufferRemoteResponse } from "./remoteUrlSafety";

const TTL_MS = Number(process.env.MIKE_MODEL_CATALOG_TTL_MS) || 300_000;

export async function fetchCatalogJson<T>(url: string, { label, timeoutMs, headers }: {
  label: string; timeoutMs: number; headers?: Record<string, string>;
}): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} failed (HTTP ${response.status}).`);
  }
  return await (await bufferRemoteResponse(response, {
    label, maxBytes: 1024 * 1024, contentTypes: ["application/json"],
  })).json() as T;
}

/**
 * Stale-while-revalidate cache for a provider model catalog: `snapshot` answers
 * from the last known catalog and refreshes in the background, so a slow,
 * throttled, or absent provider never delays a request.
 */
export function createCatalogCache<T extends { source: "live" | "unavailable" }, I = void>(probe: (input: I) => Promise<T>, empty: T) {
  let known: T | undefined, checkedAt = 0, inflight: Promise<T> | null = null;
  const stale = () => Date.now() - checkedAt > TTL_MS;
  const refresh = (input: I) => {
    checkedAt = Date.now();
    return inflight ??= probe(input).then((value) => known = value)
      .catch(() => known = { ...(known ?? empty), source: "unavailable" }).finally(() => { inflight = null; });
  };
  return {
    snapshot: (input: I): T => { if (stale()) void refresh(input); return known ?? empty; },
    resolve: (input: I) => stale() ? refresh(input) : Promise.resolve(known ?? empty),
  };
}

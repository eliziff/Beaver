import { useEffect, useState } from "react";
import { API_BASE, apiFetch } from "@/app/lib/beaverApi";
import { invalidateSingleDoc } from "@/app/hooks/useFetchSingleDoc";
interface FetchDocxResult {
    bytes: ArrayBuffer | null;
    downloadUrl: string | null;
    loading: boolean;
    error: string | null;
}
const bytesCache = new Map<string, ArrayBuffer>();
const inFlight = new Map<string, Promise<ArrayBuffer>>();
type FetchState = Pick<FetchDocxResult, "bytes" | "error"> & {
    key: string | null;
};
function cacheKey(
    documentId: string,
    versionId?: string | null,
    refetchKey?: string | number,
): string {
    return `${documentId}:${versionId ?? ""}:${refetchKey ?? ""}`;
}
function cachedState(key: string | null): FetchState {
    return {
        key,
        bytes: key ? (bytesCache.get(key) ?? null) : null,
        error: null,
    };
}
export function preloadDocxBytes(
    documentId: string,
    versionId?: string | null,
    refetchKey?: string | number,
): Promise<ArrayBuffer> {
    const key = cacheKey(documentId, versionId, refetchKey);
    const cached = bytesCache.get(key);
    if (cached) return Promise.resolve(cached);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const query = versionId
        ? `?version_id=${encodeURIComponent(versionId)}`
        : "";
    const path = `/single-documents/${documentId}/file${query}`;
    const pending = apiFetch(path, { headers: { Accept: "*/*" } })
        .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.arrayBuffer();
        })
        .then((bytes) => {
            bytesCache.set(key, bytes);
            return bytes;
        });
    inFlight.set(key, pending);
    const cleanup = () => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
    };
    void pending.then(cleanup, cleanup);
    return pending;
}
export function useFetchDocxBytes(
    documentId: string | null | undefined,
    versionId?: string | null,
    refetchKey?: string | number,
): FetchDocxResult {
    const key = documentId ? cacheKey(documentId, versionId, refetchKey) : null;
    const query = versionId
        ? `?version_id=${encodeURIComponent(versionId)}`
        : "";
    const path = documentId ? `/single-documents/${documentId}/file${query}` : null;
    const [state, setState] = useState(() => cachedState(key));
    const current = state.key === key ? state : cachedState(key);
    useEffect(() => {
        if (!documentId || !key || !path || bytesCache.has(key)) return;
        let cancelled = false;
        const pending = preloadDocxBytes(documentId, versionId, refetchKey);
        pending
            .then((buf) => {
                if (cancelled) return;
                setState({ key, bytes: buf, error: null });
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setState({
                    key,
                    bytes: null,
                    error: e instanceof Error ? e.message : String(e),
                });
            });
        return () => {
            cancelled = true;
        };
    }, [documentId, key, path, refetchKey, versionId]);
    return {
        bytes: current.bytes,
        downloadUrl: current.bytes && path ? `${API_BASE}${path}` : null,
        loading: !!key && !current.bytes && !current.error,
        error: current.error,
    };
}
export function invalidateDocxBytes(
    documentId: string,
    versionId?: string | null,
): void {
    invalidateSingleDoc(documentId, versionId);
    if (versionId !== undefined) {
        for (const key of Array.from(bytesCache.keys())) {
            if (key.startsWith(`${documentId}:${versionId ?? ""}:`)) {
                bytesCache.delete(key);
            }
        }
        return;
    }
    for (const key of Array.from(bytesCache.keys())) {
        if (key.startsWith(`${documentId}:`)) bytesCache.delete(key);
    }
}

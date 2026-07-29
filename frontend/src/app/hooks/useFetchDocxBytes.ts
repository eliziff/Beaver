"use client";
import { useEffect, useState } from "react";
import { API_BASE, apiFetch } from "@/app/lib/beaverApi";export interface FetchDocxResult {
    bytes: ArrayBuffer | null;
    downloadUrl: string | null;
    loading: boolean;
    error: string | null;
}
const bytesCache = new Map<string, ArrayBuffer>();
const inFlight = new Map<string, Promise<ArrayBuffer>>();
function cacheKey(
    documentId: string,
    versionId?: string | null,
    refetchKey?: string | number,
): string {
    return `${documentId}:${versionId ?? ""}:${refetchKey ?? ""}`;
}
export function useFetchDocxBytes(
    documentId: string | null | undefined,
    versionId?: string | null,
    refetchKey?: string | number,
): FetchDocxResult {
    const initialKey = documentId
        ? cacheKey(documentId, versionId, refetchKey)
        : null;
    const [bytes, setBytes] = useState<ArrayBuffer | null>(
        initialKey ? (bytesCache.get(initialKey) ?? null) : null,
    );
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!documentId) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale bytes when documentId is removed, within the fetch effect
            setBytes(null);
            setDownloadUrl(null);
            return;
        }
        const key = cacheKey(documentId, versionId, refetchKey);
        const qs = versionId            ? `?version_id=${encodeURIComponent(versionId)}`            : "";        const path = `/single-documents/${documentId}/docx${qs}`;        const url = `${API_BASE}${path}`;        const cached = bytesCache.get(key);
        if (cached) {
            setBytes(cached);
            setDownloadUrl(url);
            setLoading(false);
            setError(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        const pending =
            inFlight.get(key) ??
            (async () => {
                const bin = await apiFetch(path, {                    headers: { Accept: "*/*" },                });                if (!bin.ok) throw new Error(`HTTP ${bin.status}`);
                const buf = await bin.arrayBuffer();
                bytesCache.set(key, buf);
                return buf;
            })();
        if (!inFlight.has(key)) inFlight.set(key, pending);
        pending
            .then((buf) => {
                if (cancelled) return;
                setBytes(buf);
                setDownloadUrl(url);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
                inFlight.delete(key);
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [documentId, versionId, refetchKey]);
    return { bytes, downloadUrl, loading, error };
}
export function invalidateDocxBytes(
    documentId: string,
    versionId?: string | null,
): void {
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

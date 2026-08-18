import { useEffect, useState } from "react";
import { apiFetch } from "@/app/lib/beaverApi";type DocResult =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "spreadsheet"; buffer: ArrayBuffer }
    | { type: "docx"; buffer: ArrayBuffer }
    | { type: "text"; buffer: ArrayBuffer }
    | null;
type LoadedDoc = Exclude<DocResult, null>;
let cached: { key: string; result: LoadedDoc } | null = null;
let pending: { key: string; promise: Promise<LoadedDoc> } | null = null;
function isSpreadsheetContentType(contentType: string): boolean {
    return (
        contentType.includes("spreadsheetml") || // .xlsx
        contentType.includes("ms-excel") // .xls / .xlsm
    );
}
function requestKey(
    documentId: string,
    versionId?: string | null,
    revision?: string | number | null,
) {
    return `${documentId}:${versionId ?? "current"}:${revision ?? ""}`;
}
async function loadSingleDoc(
    documentId: string,
    versionId?: string | null,
    revision?: string | number | null,
): Promise<LoadedDoc> {
    const key = requestKey(documentId, versionId, revision);
    if (cached?.key === key) return cached.result;
    if (pending?.key === key) return pending.promise;
    const promise = (async () => {
        const qs = versionId            ? `?rendition=pdf&version_id=${encodeURIComponent(versionId)}`            : "?rendition=pdf";        const response = await apiFetch(            `/single-documents/${documentId}/file${qs}`,            { cache: "default", headers: { Accept: "*/*" } },        );        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") ?? "";
        let result: LoadedDoc;
        if (contentType.includes("application/pdf")) {
            result = { type: "pdf", buffer: await response.arrayBuffer() };
        } else if (isSpreadsheetContentType(contentType)) {
            result = {
                type: "spreadsheet",
                buffer: await response.arrayBuffer(),
            };
        } else if (contentType.startsWith("text/")) {
            // Plain text and Markdown ARE their content. Without this branch
            // they fall through to the docx renderer, which cannot open them.
            result = { type: "text", buffer: await response.arrayBuffer() };
        } else {
            result = { type: "docx", buffer: await response.arrayBuffer() };
        }
        cached = { key, result };
        return result;
    })();
    pending = { key, promise };
    void promise
        .finally(() => {
            if (pending?.promise === promise) pending = null;
        })
        .catch(() => {});
    return promise;
}
export function preloadSingleDoc(
    documentId: string,
    versionId?: string | null,
    revision?: string | number | null,
) {
    return loadSingleDoc(documentId, versionId, revision);
}
export function invalidateSingleDoc(
    documentId: string,
    versionId?: string | null,
) {
    const prefix =
        versionId === undefined
            ? `${documentId}:`
            : `${documentId}:${versionId ?? "current"}:`;
    if (cached?.key.startsWith(prefix)) cached = null;
}
export function useFetchSingleDoc(
    documentId: string | null | undefined,
    versionId?: string | null,
    revision?: string | number | null,
) {
    const key = documentId
        ? requestKey(documentId, versionId, revision)
        : null;
    const [state, setState] = useState<{
        key: string | null;
        result: DocResult;
        error: string | null;
    }>(() => ({
        key,
        result: key && cached?.key === key ? cached.result : null,
        error: null,
    }));
    useEffect(() => {
        if (!documentId || !key) return;
        let cancelled = false;
        loadSingleDoc(documentId, versionId, revision)
            .then((loaded) => {
                if (!cancelled) setState({ key, result: loaded, error: null });
            })
            .catch(() => {
                if (!cancelled) {
                    setState({
                        key,
                        result: null,
                        error: "Failed to load document.",
                    });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [documentId, key, revision, versionId]);
    const result =
        key && cached?.key === key
            ? cached.result
            : state.key === key
              ? state.result
              : null;
    const error = state.key === key ? state.error : null;
    return { result, loading: !!key && !result && !error, error };
}

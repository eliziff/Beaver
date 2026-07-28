"use client";

import { useEffect, useState } from "react";
import { getAuthHeader } from "@/app/lib/beaverApi";

/**
 * /display returns PDF bytes (when the active version has a PDF rendition),
 * raw spreadsheet bytes (xlsx/xlsm/xls — never converted to PDF), or raw DOCX
 * bytes otherwise. Reporting the type lets the caller swap between PdfView
 * (PDF.js), SpreadsheetView (Fortune-sheet), and DocxView (docx-preview).
 */
export type DocResult =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "spreadsheet"; buffer: ArrayBuffer }
    | { type: "docx" }
    | null;

type LoadedDoc = Exclude<DocResult, null>;
let cached: { key: string; result: LoadedDoc } | null = null;
let pending: { key: string; promise: Promise<LoadedDoc> } | null = null;

/** Office spreadsheet content types served raw by /display. */
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
        const authHeaders = await getAuthHeader();
        const apiBase =
            process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
        const qs = versionId
            ? `?version_id=${encodeURIComponent(versionId)}`
            : "";
        const response = await fetch(
            `${apiBase}/single-documents/${documentId}/display${qs}`,
            { headers: authHeaders },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const contentType = response.headers.get("content-type") ?? "";
        let result: LoadedDoc;
        if (contentType.includes("application/pdf")) {
            result = { type: "pdf", buffer: await response.arrayBuffer() };
        } else if (isSpreadsheetContentType(contentType)) {
            result = {
                type: "spreadsheet",
                buffer: await response.arrayBuffer(),
            };
        } else {
            await response.arrayBuffer().catch(() => {});
            result = { type: "docx" };
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
        if (!documentId || !key || cached?.key === key) return;

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

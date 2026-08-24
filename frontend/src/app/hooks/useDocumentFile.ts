import { useEffect, useState } from "react";
import { apiFetch } from "../lib/beaverApi";

export type DocumentFile = {
  type: "pdf" | "spreadsheet" | "docx" | "text";
  buffer: ArrayBuffer;
};

const cache = new Map<string, DocumentFile>();
const pending = new Map<string, Promise<DocumentFile>>();
let cacheGeneration = 0;

export function clearDocumentFileCache() {
  cacheGeneration += 1;
  cache.clear();
  pending.clear();
}

function keyFor(
  documentId: string,
  versionId: string | null | undefined,
  revision: string | number | null | undefined,
  original: boolean,
) {
  return `${documentId}:${versionId ?? "current"}:${revision ?? ""}:${original ? "original" : "pdf"}`;
}

function fileType(contentType: string): DocumentFile["type"] {
  if (contentType.includes("application/pdf")) return "pdf";
  if (contentType.includes("spreadsheetml") || contentType.includes("ms-excel")) {
    return "spreadsheet";
  }
  if (contentType.startsWith("text/")) return "text";
  return "docx";
}

async function load(
  documentId: string,
  versionId?: string | null,
  revision?: string | number | null,
  original = false,
) {
  const key = keyFor(documentId, versionId, revision, original);
  const hit = cache.get(key);
  if (hit) return hit;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const query = new URLSearchParams();
  if (!original) query.set("rendition", "pdf");
  if (versionId) query.set("version_id", versionId);
  const search = query.toString();
  const generation = cacheGeneration;
  const request = apiFetch(
    `/single-documents/${encodeURIComponent(documentId)}/file${search ? `?${search}` : ""}`,
    { cache: "default", headers: { Accept: "*/*" } },
  ).then(async (response) => {
    if (!response.ok) throw new Error(`Failed to load document (${response.status})`);
    if (generation !== cacheGeneration) throw new Error("Authentication changed");
    const result: DocumentFile = {
      type: fileType(response.headers.get("content-type") ?? ""),
      buffer: await response.arrayBuffer(),
    };
    if (result.type !== "pdf") cache.set(key, result);
    const oldest = cache.keys().next().value;
    if (cache.size > 8 && oldest) cache.delete(oldest);
    return result;
  });
  pending.set(key, request);
  void request.finally(() => {
    if (pending.get(key) === request) pending.delete(key);
  }).catch(() => undefined);
  return request;
}

export function preloadDocumentFile(
  documentId: string,
  versionId?: string | null,
  revision?: string | number | null,
  original = false,
) {
  return load(documentId, versionId, revision, original);
}

export function useDocumentFile(
  documentId: string | null | undefined,
  versionId?: string | null,
  revision?: string | number | null,
  original = false,
) {
  const key = documentId ? keyFor(documentId, versionId, revision, original) : null;
  const [state, setState] = useState<{
    key: string | null;
    result: DocumentFile | null;
    error: string | null;
  }>(() => ({ key, result: key ? cache.get(key) ?? null : null, error: null }));
  const current = key && cache.get(key)
    ? { key, result: cache.get(key)!, error: null }
    : state.key === key ? state : { key, result: null, error: null };

  useEffect(() => {
    if (!documentId || !key || current.result) return;
    let live = true;
    void load(documentId, versionId, revision, original)
      .then((result) => live && setState({ key, result, error: null }))
      .catch(() => live && setState({ key, result: null, error: "Failed to load document." }));
    return () => {
      live = false;
    };
  }, [documentId, key, original, revision, versionId]);

  return {
    result: current.result,
    error: current.error,
    loading: !!key && !current.result && !current.error,
  };
}

export function invalidateDocumentFile(documentId: string) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${documentId}:`)) cache.delete(key);
  }
}

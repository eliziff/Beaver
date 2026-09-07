import { useEffect, useState } from "react";
import { readDocumentFile } from "@/app/lib/api/documents";

export type DocumentFile = {
  type: "pdf" | "spreadsheet" | "docx" | "text";
  buffer: ArrayBuffer;
};

const sessions = new Map<AbortController, string>();
const cache = new Map<string, DocumentFile>();
const pending = new Map<string, { promise: Promise<DocumentFile>; controller: AbortController }>();
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
let cacheBytes = 0;
function evict(key: string) {
  const file = cache.get(key);
  if (file) cacheBytes -= file.buffer.byteLength;
  cache.delete(key);
}
function cached(key: string) {
  const file = cache.get(key);
  if (file) { cache.delete(key); cache.set(key, file); }
  return file;
}
function retain(key: string, file: DocumentFile) {
  evict(key);
  // An active reader can still display a large file; do not retain another
  // oversized working set merely because fewer than eight files were opened.
  if (file.buffer.byteLength > MAX_CACHE_BYTES) return;
  cache.set(key, file); cacheBytes += file.buffer.byteLength;
  while (cache.size > 8 || cacheBytes > MAX_CACHE_BYTES) evict(cache.keys().next().value!);
}
let cacheGeneration = 0;

export function clearDocumentFileCache() {
  cacheGeneration += 1;
  cache.clear(); cacheBytes = 0;
  for (const request of pending.values()) request.controller.abort();
  pending.clear();
  for (const controller of sessions.keys()) controller.abort();
  sessions.clear();
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
  const hit = cached(key);
  if (hit) return hit;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight.promise;

  const generation = cacheGeneration;
  const controller = new AbortController();
  const current = () => {
    if (generation !== cacheGeneration || controller.signal.aborted || pending.get(key)?.promise !== request)
      throw new DOMException("Document request was superseded", "AbortError");
  };
  const request = readDocumentFile(documentId, versionId, original, controller.signal).then(async (response) => {
    if (!response.ok) throw new Error(`Failed to load document (${response.status})`);
    current();
    const result: DocumentFile = {
      type: fileType(response.headers.get("content-type") ?? ""),
      buffer: await response.arrayBuffer(),
    };
    // Authentication/invalidation can change while the body, not just headers,
    // is loading. A late old body must never repopulate the new account's cache.
    current();
    retain(key, result);
    return result;
  });
  pending.set(key, { promise: request, controller });
  void request.finally(() => {
    if (pending.get(key)?.promise === request) pending.delete(key);
  }).catch(() => undefined);
  return request;
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
  }>(() => ({ key, result: key ? cached(key) ?? null : null, error: null }));
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
  }, [current.result, documentId, key, original, revision, versionId]);

  return {
    result: current.result,
    error: current.error,
    loading: !!key && !current.result && !current.error,
  };
}

export function invalidateDocumentFile(documentId: string) {
  for (const [controller, key] of sessions) if (key.startsWith(`${documentId}:`)) {
    controller.abort(); sessions.delete(controller);
  }
  for (const [key, request] of pending) {
    if (!key.startsWith(`${documentId}:`)) continue;
    request.controller.abort(); pending.delete(key);
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${documentId}:`)) evict(key);
  }
}

// A viewer owns a consumable PDF.js transport; only complete buffers enter the
// existing cache. Auth clears and explicit document invalidation abort its reads.
export function documentFileSession(documentId: string, versionId?: string | null,
  revision?: string | number | null) {
  const key = keyFor(documentId, versionId, revision, false);
  const controller = new AbortController(), generation = cacheGeneration;
  sessions.set(controller, key);
  return {
    signal: controller.signal, cached: cached(key),
    retain(file: DocumentFile) {
      controller.signal.throwIfAborted();
      if (generation === cacheGeneration) retain(key, file);
    },
    close() { controller.abort(); sessions.delete(controller); },
  };
}

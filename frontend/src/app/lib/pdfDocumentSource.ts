import { apiFetch, segment, pagePath } from "./api/client";
import { getPdfJs } from "./pdfJs";
import { documentFileSession } from "@/app/hooks/useDocumentFile";
import type { PdfByteSource } from "@/app/components/shared/views/PdfCanvas";

const CHUNK = 64 * 1024, MAX_BYTES = 100 * 1024 * 1024;
function representation(response: Response) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get("Content-Range") ?? "");
  const etag = response.headers.get("ETag");
  if (!match || !etag || !/^"[a-f0-9]{64}"$/u.test(etag)) throw new Error("Invalid PDF range response");
  const [start, end, length] = match.slice(1).map(Number);
  if (![start, end, length].every(Number.isSafeInteger) || start > end || end >= length || length > MAX_BYTES)
    throw new Error("Invalid PDF range bounds");
  return { start, end, length, etag };
}
async function readBytes(response: Response, signal: AbortSignal) {
  if (!response.ok || response.headers.get("Content-Type")?.split(";")[0] !== "application/pdf")
    throw new Error(`PDF is unavailable (${response.status})`);
  const announced = Number(response.headers.get("Content-Length"));
  if (announced > MAX_BYTES) throw new Error("PDF exceeds the viewer byte limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Invalid PDF size");
  return bytes;
}

export function createPdfDocumentSource(documentId: string, versionId?: string | null,
  revision?: string | number | null): PdfByteSource {
  return async (outerSignal, onError) => {
    const session = documentFileSession(documentId, versionId, revision);
    const signal = AbortSignal.any([outerSignal, session.signal]);
    let closed = false;
    const close = () => {
      closed = true; session.close();
      outerSignal.removeEventListener("abort", close);
      session.signal.removeEventListener("abort", invalidated);
    };
    const invalidated = () => {
      if (!closed && !outerSignal.aborted) onError(new Error("Document request was invalidated"));
      close();
    };
    session.signal.addEventListener("abort", invalidated, { once: true });
    outerSignal.addEventListener("abort", close, { once: true });
    const path = pagePath(`/single-documents/${segment(documentId)}/file`, { rendition: "pdf", version_id: versionId });
    const request = (start: number, end: number, etag?: string) => apiFetch(path, {
      headers: { Accept: "application/pdf", Range: `bytes=${start}-${end - 1}`, ...(etag ? { "If-Match": etag } : {}) },
      signal, redirect: "error",
    });
    try {
      signal.throwIfAborted();
      // Keep even complete-file sessions attached to the viewer lifetime so
      // explicit invalidation/auth clearing removes already-rendered content.
      const cached = session.cached;
      if (cached) {
        if (cached.type !== "pdf") throw new Error("This document is not a PDF");
        return { data: new Uint8Array(cached.buffer.slice(0)) };
      }
      const [lib, first] = await Promise.all([getPdfJs(), request(0, CHUNK)]);
      const initial = await readBytes(first, signal);
      if (first.status === 200) {
        session.retain({ type: "pdf", buffer: initial.buffer.slice(0) });
        return { data: initial };
      }
      if (first.status !== 206) throw new Error("Invalid PDF response");
      const identity = representation(first);
      if (identity.start !== 0 || identity.end !== Math.min(CHUNK, identity.length) - 1 || initial.length !== identity.end + 1)
        throw new Error("Incomplete initial PDF range");
      if (initial.length === identity.length) {
        session.retain({ type: "pdf", buffer: initial.buffer.slice(0) });
        return { data: initial };
      }
      const transport = new lib.PDFDataRangeTransport(identity.length, initial, true);
      transport.requestDataRange = (start, end) => {
        void (async () => {
          signal.throwIfAborted();
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > identity.length)
            throw new Error("Invalid requested PDF range");
          const response = await request(start, end, identity.etag);
          if (response.status !== 206) throw new Error("Document changed or access was revoked");
          const received = representation(response);
          if (received.etag !== identity.etag || received.length !== identity.length || received.start !== start || received.end !== end - 1)
            throw new Error("Document range no longer matches this version");
          const bytes = await readBytes(response, signal);
          if (bytes.length !== end - start) throw new Error("Incomplete PDF range");
          transport.onDataRange(start, bytes);
        })().catch((cause: unknown) => {
          if (signal.aborted) return;
          onError(cause instanceof Error ? cause : new Error(String(cause)));
          close();
        });
      };
      transport.abort = close;
      return { range: transport, rangeChunkSize: CHUNK, disableStream: true, disableAutoFetch: true };
    } catch (error) { close(); throw error; }
  };
}

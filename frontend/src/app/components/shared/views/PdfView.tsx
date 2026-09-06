import { useEffect, useMemo } from "react";
import { useDocumentFile } from "@/app/hooks/useDocumentFile";
import { PdfCanvas, type PdfCanvasProps } from "./PdfCanvas";
import { getPdfJs } from "./highlightQuote";

/** Beaver document adapter. The same renderer also works with standalone file bytes. */
export function PdfView({ doc, bytes, revision, annotationEditor, ...props }: PdfCanvasProps & {
  doc: { document_id: string; version_id?: string | null } | null;
  revision?: string | number | null;
}) {
  // Discover the engine while the authorized file request is in flight.
  useEffect(() => {
    if (doc && !bytes) void getPdfJs().catch(() => undefined);
  }, [doc?.document_id, bytes]);
  const { result, loading, error } = useDocumentFile(
    bytes ? null : doc?.document_id ?? null, doc?.version_id ?? null, revision);
  const data = useMemo(() => bytes ?? (result?.type === "pdf"
    ? new Uint8Array(result.buffer) : undefined), [bytes, result]);
  return <PdfCanvas {...props} annotationEditor={annotationEditor} bytes={data} loading={!bytes && loading}
    error={bytes ? null : error || (result && result.type !== "pdf" ? "This document is not a PDF." : null)} />;
}

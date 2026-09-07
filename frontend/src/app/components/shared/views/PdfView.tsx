import { useMemo } from "react";
import { PdfCanvas, type PdfCanvasProps } from "./PdfCanvas";
import { createPdfDocumentSource } from "@/app/lib/pdfDocumentSource";

/** Authorized document adapter; standalone callers continue to supply owned bytes. */
export function PdfView({ doc, bytes, revision, ...props }: Omit<PdfCanvasProps, "source"> & {
  doc: { document_id: string; version_id?: string | null } | null;
  revision?: string | number | null;
}) {
  const source = useMemo(() => !bytes && doc
    ? createPdfDocumentSource(doc.document_id, doc.version_id, revision) : undefined,
  [bytes, doc?.document_id, doc?.version_id, revision]);
  return <PdfCanvas {...props} bytes={bytes} source={source} />;
}

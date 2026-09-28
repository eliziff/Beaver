import { useEffect, useMemo, useState } from "react";
import { PdfCanvas, type PdfCanvasProps } from "./PdfCanvas";
import { createPdfDocumentSource, getDocumentPdfPageLabels } from "@/app/lib/pdfDocumentSource";

/** Authorized document adapter; standalone callers continue to supply owned bytes. */
export function PdfView({ doc, bytes, revision, ...props }: Omit<PdfCanvasProps, "source"> & {
  doc: { document_id: string; version_id?: string | null } | null;
  revision?: string | number | null;
}) {
  const key = JSON.stringify([doc?.document_id, doc?.version_id, revision]);
  const [detected, setDetected] = useState<{ key: string; labels: Array<string | null> }>();
  useEffect(() => {
    if (!doc || props.pageLabels) return;
    const controller = new AbortController();
    void getDocumentPdfPageLabels(doc.document_id, doc.version_id, controller.signal).then(result => {
      if (!controller.signal.aborted) setDetected({ key, labels: result.pageLabels });
    }).catch(() => { /* Detection must not prevent reading or physical page navigation. */ });
    return () => controller.abort();
  }, [key, props.pageLabels]);
  const source = useMemo(() => !bytes && doc
    ? createPdfDocumentSource(doc.document_id, doc.version_id, revision) : undefined,
  [bytes, doc?.document_id, doc?.version_id, revision]);
  return <PdfCanvas {...props} pageLabels={props.pageLabels ?? (detected?.key === key ? detected.labels : undefined)} bytes={bytes} source={source} />;
}

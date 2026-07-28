"use client";

import type { ComponentProps } from "react";
import { DocxView } from "./DocxView";
import { PdfView } from "./PdfView";
import { SpreadsheetView, type HighlightCell } from "./SpreadsheetView";

export type DocumentViewerKind = "docx" | "pdf" | "spreadsheet";

type ViewerOptions = Partial<
    ComponentProps<typeof DocxView> &
        ComponentProps<typeof PdfView> &
        ComponentProps<typeof SpreadsheetView>
>;

export type DocumentViewerProps = ViewerOptions & {
    documentId: string;
    kind: DocumentViewerKind;
    versionId?: string | null;
};

export function DocumentViewer({
    documentId,
    kind,
    versionId,
    ...options
}: DocumentViewerProps) {
    if (kind === "docx")
        return <DocxView documentId={documentId} versionId={versionId} {...options} />;
    if (kind === "spreadsheet")
        return <SpreadsheetView documentId={documentId} versionId={versionId} {...options} />;
    return <PdfView doc={{ document_id: documentId, version_id: versionId }} {...options} />;
}

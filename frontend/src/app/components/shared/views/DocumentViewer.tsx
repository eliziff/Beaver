import { lazy, Suspense, type ComponentProps } from "react";
import { DocxView } from "./DocxView";
import { PdfView } from "./PdfView";
import { TextView } from "./TextView";
import type { SpreadsheetView } from "./SpreadsheetView";

const SpreadsheetRenderer = lazy(() =>
    import("./SpreadsheetView").then(({ SpreadsheetView }) => ({
        default: SpreadsheetView,
    })),
);

export type DocumentViewerKind = "docx" | "pdf" | "spreadsheet" | "text";
type ViewerOptions = Partial<
    ComponentProps<typeof DocxView> &
        ComponentProps<typeof PdfView> &
        ComponentProps<typeof SpreadsheetView> &
        ComponentProps<typeof TextView>
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
    const renderer =
        kind === "docx" ? (
            <DocxView
                documentId={documentId}
                versionId={versionId}
                {...options}
            />
        ) : kind === "text" ? (
            <TextView
                documentId={documentId}
                versionId={versionId}
                {...options}
            />
        ) : kind === "spreadsheet" ? (
            <SpreadsheetRenderer
                documentId={documentId}
                versionId={versionId}
                {...options}
            />
        ) : (
            <PdfView
                doc={{ document_id: documentId, version_id: versionId }}
                {...options}
            />
        );
    return <Suspense fallback={
        <div className="flex h-full min-h-0 items-center justify-center text-sm text-gray-500" role="status">
            Loading document…
        </div>
    }>{renderer}</Suspense>;
}

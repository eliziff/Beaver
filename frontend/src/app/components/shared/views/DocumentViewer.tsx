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
    const Renderer = kind === "docx" ? DocxView : kind === "text" ? TextView : SpreadsheetRenderer;
    return <Suspense fallback={
        <div className="flex h-full min-h-0 items-center justify-center text-sm text-gray-500" role="status">
            Loading document…
        </div>
    }><div data-reader-view className="flex min-h-0 min-w-0 flex-1 flex-col">
        {kind === "pdf" ? <PdfView doc={{ document_id: documentId, version_id: versionId }} {...options} />
            : <Renderer documentId={documentId} versionId={versionId} {...options} />}
    </div></Suspense>;
}

import { useDocumentFile } from "@/app/hooks/useDocumentFile";
import { DocxCanvas, type DocxCanvasProps } from "./DocxCanvas";

/** Library file access stays outside the shared Word renderer. */
export function DocxView({ documentId, versionId, refetchKey, ...props }:
    Omit<DocxCanvasProps, "bytes" | "error" | "documentId"> & {
        documentId: string; refetchKey?: string | number;
    }) {
    const { result, error } = useDocumentFile(documentId, versionId, refetchKey, true);
    return <DocxCanvas {...props} documentId={documentId} versionId={versionId}
        bytes={result?.buffer} error={error} />;
}

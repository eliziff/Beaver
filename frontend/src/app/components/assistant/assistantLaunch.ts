import type { Document } from "@/app/lib/api/documents";

const NEW_CHAT_DOCUMENTS = "beaver:new-chat-documents";

export const clearStagedChatDocuments = () =>
    typeof window === "undefined" || sessionStorage.removeItem(NEW_CHAT_DOCUMENTS);

export function stageNewChatDocuments(documents: (Pick<Document, "id" | "filename"> & Partial<Document>)[]) {
    if (typeof window === "undefined") return;
    sessionStorage.setItem(NEW_CHAT_DOCUMENTS, JSON.stringify(documents.map((document) => ({
        project_id: null, file_type: null, pdf_storage_path: null, size_bytes: null,
        page_count: null, created_at: null, ...document,
    }))));
}

export function takeNewChatDocuments(): Document[] {
    if (typeof window === "undefined") return [];
    try {
        const documents = JSON.parse(
            sessionStorage.getItem(NEW_CHAT_DOCUMENTS) ?? "[]",
        ) as unknown;
        clearStagedChatDocuments();
        return Array.isArray(documents)
            ? documents.filter(
                  (document): document is Document =>
                      !!document &&
                      typeof document === "object" &&
                      typeof (document as Document).id === "string" &&
                      typeof (document as Document).filename === "string",
              )
            : [];
    } catch {
        clearStagedChatDocuments();
        return [];
    }
}

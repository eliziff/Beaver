import type { Document } from "@/app/components/shared/types";

const NEW_CHAT_DOCUMENTS = "beaver:new-chat-documents";

export function stageNewChatDocuments(documents: Document[]) {
    if (typeof window === "undefined") return;
    sessionStorage.setItem(NEW_CHAT_DOCUMENTS, JSON.stringify(documents));
}

export function takeNewChatDocuments(): Document[] {
    if (typeof window === "undefined") return [];
    try {
        const documents = JSON.parse(
            sessionStorage.getItem(NEW_CHAT_DOCUMENTS) ?? "[]",
        ) as unknown;
        sessionStorage.removeItem(NEW_CHAT_DOCUMENTS);
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
        sessionStorage.removeItem(NEW_CHAT_DOCUMENTS);
        return [];
    }
}

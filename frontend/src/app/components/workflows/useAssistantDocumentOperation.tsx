import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";
import { stageNewChatDocuments } from "../assistant/assistantLaunch";
import type { Message } from "@/app/lib/api/chat";
import { WarningPopup } from "../popups/WarningPopup";
import type { WorkflowDocument } from "./ContextualWorkflowPicker";

export const FIX_SUPRAS = {
    title: "Fix supras", accept: ".docx",
    prompt: "Fix the supra references in this document using native Word cross-references, with tracked changes for review.",
};

export function useAssistantDocumentOperation(operation: { title: string; accept: string; prompt: string }, { onRun, onLaunched }: {
    onRun?: (message: Message, document: WorkflowDocument) => Promise<unknown> | void;
    onLaunched?: () => void;
} = {}) {
    const [selecting, setSelecting] = useState(false);
    const [launching, setLaunching] = useState(false);
    const [launchError, setLaunchError] = useState<string | null>(null);
    const navigate = useNavigate();
    const { saveChat, stagePendingChatMessage } = useChatHistoryContext();
    async function run(docx: WorkflowDocument) {
        if (launching) return;
        setLaunching(true); setLaunchError(null);
        try {
            const message: Message = { role: "user", content:
                operation.prompt,
                files: [{ document_id: docx.id, filename: docx.filename }], editMode: "manual" };
            if (onRun) await onRun(message, docx);
            else {
                const chatId = await saveChat(docx.project_id ?? undefined);
                if (!chatId) throw new Error("Unable to create the chat.");
                stagePendingChatMessage(chatId, message);
                stageNewChatDocuments([docx]);
                navigate(docx.project_id ? `/projects/${docx.project_id}/assistant/chat/${chatId}`
                    : `/assistant/chat/${chatId}`);
            }
            setSelecting(false); onLaunched?.();
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to start the operation.";
            setLaunchError(`${message} Try again.`);
        } finally { setLaunching(false); }
    }


    return { launching, launch: (document?: WorkflowDocument | null) => {
        if (document && operation.accept.split(",").some((extension) => document.filename.toLowerCase().endsWith(extension))) void run(document);
        else setSelecting(true);
    }, picker: <>
        <AddDocumentsModal open={selecting} breadcrumb={[operation.title, "Choose document"]}
            accept={operation.accept} multiple={false} busy={launching}
            tabs={[["files", "Files"], ["projects", "Projects"]]}
            documentFilter={(document) => document.library_kind !== "template"}
            primaryLabel={operation.title}
            onSelect={([document]) => document && run(document)} onClose={() => setSelecting(false)} />
        <WarningPopup open={!!launchError} message={launchError ?? ""} onClose={() => setLaunchError(null)} />
    </> };
}

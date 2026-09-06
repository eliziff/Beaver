import { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { InitialView } from "@/app/components/assistant/InitialView";
import { stageNewChatDocuments, takeNewChatDocuments } from "@/app/components/assistant/assistantLaunch";
import type { Message, ChatDraft } from "@/app/lib/api/chat";
import { writeChatDraft } from "@/app/lib/chatDrafts";
import type { AssistantWorkflowLaunch } from "@/app/components/workflows/workflowRoutes";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";

export default function AssistantPage() {
    const { key } = useLocation();
    return <NewAssistantChat key={key} />;
}
function NewAssistantChat() {
    const navigate = useNavigate();
    const { state } = useLocation();
    const { saveChat, stagePendingChatMessage, loadChats } = useChatHistoryContext();
    const draftChat = useRef<Promise<string | null> | null>(null);
    const ensureChat = () => draftChat.current ??= saveChat();
    async function saveDraft(draft: ChatDraft | null) {
        if (!draftChat.current && !draft) return;
        const id = await ensureChat();
        if (!id) { draftChat.current = null; throw new Error("Could not create chat"); }
        await writeChatDraft(id, draft);
        await loadChats();
    }
    const [initialDocuments] = useState(takeNewChatDocuments);
    async function handleInitialSubmit(message: Message) {
        if (!message.content.trim()) return;
        const chatId = await ensureChat();
        if (!chatId) return;
        stagePendingChatMessage(chatId, message);
        stageNewChatDocuments((message.files ?? []).map(({ document_id, filename }) => ({ id: document_id, filename })));
        navigate(`/assistant/chat/${chatId}`);
    }
    return <InitialView initialDocuments={initialDocuments}
        onDraftChange={saveDraft}
        initialWorkflow={(state as AssistantWorkflowLaunch | null) ?? undefined}
        onSubmit={(message) => void handleInitialSubmit(message)} />;
}

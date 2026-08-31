import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { InitialView } from "@/app/components/assistant/InitialView";
import { takeNewChatDocuments } from "@/app/components/assistant/assistantLaunch";
import type { Message } from "@/app/components/shared/types";
import type { AssistantWorkflowLaunch } from "@/app/components/workflows/workflowRoutes";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";

export default function AssistantPage() {
    const navigate = useNavigate();
    const { state } = useLocation();
    const { saveChat, stagePendingChatMessage } = useChatHistoryContext();
    const [initialDocuments] = useState(takeNewChatDocuments);
    async function handleInitialSubmit(message: Message) {
        if (!message.content.trim()) return;
        const chatId = await saveChat();
        if (!chatId) return;
        stagePendingChatMessage(chatId, message);
        navigate(`/assistant/chat/${chatId}`);
    }
    return <InitialView initialDocuments={initialDocuments}
        initialWorkflow={(state as AssistantWorkflowLaunch | null) ?? undefined}
        onSubmit={(message) => void handleInitialSubmit(message)} />;
}

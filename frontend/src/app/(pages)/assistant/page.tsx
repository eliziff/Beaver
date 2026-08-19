import { useState } from "react";import { useNavigate } from "react-router-dom";import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";import { InitialView } from "@/app/components/assistant/InitialView";import { takeNewChatDocuments } from "@/app/components/assistant/assistantLaunch";import type { Message } from "@/app/components/shared/types";export default function AssistantPage() {    const navigate = useNavigate();
    const { saveChat, stagePendingChatMessage } = useChatHistoryContext();
    const [initialDocuments] = useState(takeNewChatDocuments);
    async function handleInitialSubmit(message: Message) {
        if (!message.content.trim()) return;
        const chatId = await saveChat();
        if (!chatId) return;
        stagePendingChatMessage(chatId, message);
        navigate(`/assistant/chat/${chatId}`);
    }
    return <InitialView initialDocuments={initialDocuments} onSubmit={(message) => void handleInitialSubmit(message)} />;
}

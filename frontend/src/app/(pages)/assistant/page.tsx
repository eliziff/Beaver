"use client";import { useRouter } from "next/navigation";import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";import { InitialView } from "@/app/components/assistant/InitialView";import type { Message } from "@/app/components/shared/types";export default function AssistantPage() {    const router = useRouter();
    const { saveChat, stagePendingChatMessage } = useChatHistoryContext();
    async function handleInitialSubmit(message: Message) {
        if (!message.content.trim()) return;
        const chatId = await saveChat();
        if (!chatId) return;
        stagePendingChatMessage(chatId, message);
        router.push(`/assistant/chat/${chatId}`);
    }
    return <InitialView onSubmit={(message) => void handleInitialSubmit(message)} />;
}

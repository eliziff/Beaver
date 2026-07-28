"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { ChatView } from "@/app/components/assistant/ChatView";
import { SelectAssistantProjectModal } from "@/app/components/assistant/SelectAssistantProjectModal";
import {
    getChat,
    getProject,
    updateChatProject,
} from "@/app/lib/beaverApi";

export default function AssistantChatPage() {
    const router = useRouter();
    const params = useParams();
    const id = params.id as string;
    const [projectId, setProjectId] = useState<string | null>(null);
    const [projectName, setProjectName] = useState<string | null>(null);
    const [projectModalOpen, setProjectModalOpen] = useState(false);

    const { setCurrentChatId, newChatMessages, setNewChatMessages } =
        useChatHistoryContext();

    const initialMessages = newChatMessages ?? [];
    const {
        messages,
        isResponseLoading,
        handleChat,
        setMessages,
        setTranscriptVersion,
        rejectedTurn,
        clearRejectedTurn,
        retryRejectedTurn,
        cancel,
    } = useAssistantChat({
        initialMessages,
        chatId: id,
        projectId: projectId ?? undefined,
    });

    const hasAutoSent = useRef(false);
    const hasLoaded = useRef(false);

    useEffect(() => {
        setCurrentChatId(id);
    }, [id, setCurrentChatId]);

    useEffect(() => {
        if (initialMessages.length > 0) {
            if (newChatMessages) setNewChatMessages(null);
            return;
        }
        if (hasLoaded.current || messages.length > 0) return;
        hasLoaded.current = true;

        getChat(id)
            .then(async ({ chat, messages: loaded }) => {
                setTranscriptVersion(chat.transcript_version ?? 0);
                setProjectId(chat.project_id);
                if (chat.project_id) {
                    getProject(chat.project_id)
                        .then((project) => setProjectName(project.name))
                        .catch(() => {});
                    router.replace(
                        `/projects/${chat.project_id}/assistant/chat/${id}`,
                    );
                    return;
                }
                if (loaded.length > 0) {
                    setMessages(loaded);
                } else {
                    router.replace("/assistant");
                }
            })
            .catch(() => router.replace("/assistant"));
    }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (
            newChatMessages &&
            newChatMessages.length === 1 &&
            newChatMessages[0].role === "user" &&
            !hasAutoSent.current &&
            !isResponseLoading &&
            messages.length === 1
        ) {
            hasAutoSent.current = true;
            void handleChat(newChatMessages[0]);
        }
    }, [newChatMessages, messages.length, isResponseLoading]); // eslint-disable-line react-hooks/exhaustive-deps

    async function changeProject(nextProjectId: string | null) {
        const updated = await updateChatProject(id, nextProjectId);
        setProjectId(updated.project_id);
        if (updated.project_id) {
            const project = await getProject(updated.project_id);
            setProjectName(project.name);
            router.replace(
                `/projects/${updated.project_id}/assistant/chat/${id}`,
            );
        } else {
            setProjectName(null);
        }
    }

    return (
        <>
            <ChatView
                chatId={id}
                messages={messages}
                isResponseLoading={isResponseLoading}
                handleChat={handleChat}
                cancel={cancel}
                rejectedTurn={rejectedTurn}
                onRejectedTurnRestored={clearRejectedTurn}
                onRetryRejectedTurn={() => void retryRejectedTurn()}
                projectName={projectName}
                onProjectClick={() => setProjectModalOpen(true)}
            />
            <SelectAssistantProjectModal
                open={projectModalOpen}
                onClose={() => setProjectModalOpen(false)}
                currentProjectId={projectId}
                onSelectProject={changeProject}
            />
        </>
    );
}

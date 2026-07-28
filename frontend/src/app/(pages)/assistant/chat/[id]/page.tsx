"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
    const [chatTitle, setChatTitle] = useState<string | null>(null);
    const [projectId, setProjectId] = useState<string | null>(null);
    const [projectName, setProjectName] = useState<string | null>(null);
    const [projectModalOpen, setProjectModalOpen] = useState(false);

    const { newChatMessages, setNewChatMessages } = useChatHistoryContext();

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
    const responseLoadingRef = useRef(isResponseLoading);
    const pendingProjectRouteRef = useRef<{ projectId: string | null } | null>(
        null,
    );
    useEffect(() => {
        responseLoadingRef.current = isResponseLoading;
    }, [isResponseLoading]);
    const finishProjectMove = useCallback(
        (nextProjectId: string | null) => {
            setProjectId(nextProjectId);
            setProjectName(null);
            if (nextProjectId) {
                void getProject(nextProjectId)
                    .then((project) => setProjectName(project.name))
                    .catch(() => {});
            }
            if (responseLoadingRef.current) {
                pendingProjectRouteRef.current = {
                    projectId: nextProjectId,
                };
            } else {
                router.replace(
                    nextProjectId
                        ? `/projects/${nextProjectId}/assistant/chat/${id}`
                        : `/assistant/chat/${id}`,
                );
            }
        },
        [id, router],
    );

    const hasAutoSent = useRef(false);
    const hasLoaded = useRef(false);

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
                setChatTitle(chat.title);
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

    useEffect(() => {
        if (isResponseLoading || !pendingProjectRouteRef.current) return;
        const { projectId: nextProjectId } = pendingProjectRouteRef.current;
        pendingProjectRouteRef.current = null;
        router.replace(
            nextProjectId
                ? `/projects/${nextProjectId}/assistant/chat/${id}`
                : `/assistant/chat/${id}`,
        );
    }, [id, isResponseLoading, router]);

    useEffect(() => {
        const onProjectMoved = (event: Event) => {
            const detail = (
                event as CustomEvent<{
                    chatId?: string;
                    projectId?: string | null;
                }>
            ).detail;
            if (detail?.chatId !== id) return;
            finishProjectMove(detail.projectId ?? null);
        };
        window.addEventListener("beaver:chat-project-moved", onProjectMoved);
        return () =>
            window.removeEventListener(
                "beaver:chat-project-moved",
                onProjectMoved,
            );
    }, [finishProjectMove, id]);

    async function changeProject(nextProjectId: string | null) {
        const updated = await updateChatProject(id, nextProjectId);
        finishProjectMove(updated.project_id);
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
                chatTitle={chatTitle}
                currentLocation={projectName ?? "Assistant"}
                currentProjectId={projectId}
                onSelectProject={changeProject}
            />
        </>
    );
}

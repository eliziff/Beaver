import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getChat, getProject, updateChatProject } from "@/app/lib/beaverApi";
import type { Chat } from "@/app/components/shared/types";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAssistantChat } from "./useAssistantChat";

type ProjectLocation = { id: string | null; name: string | null };
type ProjectMovedEvent = CustomEvent<{
    chatId?: string;
    projectId?: string | null;
}>;
const chatPath = (chatId: string, projectId: string | null) =>
    projectId ? `/projects/${projectId}/assistant/chat/${chatId}` : `/assistant/chat/${chatId}`;

export function useAssistantChatRoute({
    chatId,
    projectId,
}: {
    chatId: string;
    projectId?: string;
}) {
    const router = useRouter();
    const { chats } = useChatHistoryContext();
    const [movedProject, setMovedProject] =
        useState<ProjectLocation | null>(null);
    const assistant = useAssistantChat({ chatId, projectId: projectId ?? movedProject?.id ?? undefined });
    const [loadedChat, setLoadedChat] = useState<Chat | null>();
    const responseLoadingRef = useRef(assistant.isResponseLoading);
    const pendingProjectRouteRef = useRef<string | null | undefined>(undefined);
    const hasLoaded = useRef(false);
    responseLoadingRef.current = assistant.isResponseLoading;
    const finishProjectMove = useCallback((nextProjectId: string | null) => {
            if (!projectId) {
                setMovedProject({ id: nextProjectId, name: null });
                if (nextProjectId) {
                    void getProject(nextProjectId)
                        .then(({ name }) => setMovedProject({ id: nextProjectId, name }))
                        .catch(() => {});
                }
            }
            if (responseLoadingRef.current) {
                pendingProjectRouteRef.current = nextProjectId;
            } else {
                router.replace(chatPath(chatId, nextProjectId));
            }
        },
        [chatId, projectId, router],
    );
    useEffect(() => {
        if (hasLoaded.current) return;
        hasLoaded.current = true;
        if (assistant.messages.length > 0) {
            setLoadedChat(null);
            return;
        }
        getChat(chatId)
            .then(({ chat, messages }) => {
                setLoadedChat(chat);
                assistant.setTranscriptVersion(chat.transcript_version ?? 0);
                if (!projectId && chat.project_id) {
                    finishProjectMove(chat.project_id);
                } else if (messages.length > 0) {
                    assistant.setMessages(messages);
                } else if (!projectId) {
                    router.replace("/assistant");
                }
            })
            .catch(() => {
                setLoadedChat(null);
                router.replace(
                    projectId
                        ? `/projects/${projectId}/assistant`
                        : "/assistant",
                );
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatId]);
    useEffect(() => {
        const nextProjectId = pendingProjectRouteRef.current;
        if (assistant.isResponseLoading || nextProjectId === undefined) return;
        pendingProjectRouteRef.current = undefined;
        router.replace(chatPath(chatId, nextProjectId));
    }, [assistant.isResponseLoading, chatId, router]);
    useEffect(() => {
        if (projectId) return;
        const onProjectMoved = (event: Event) => {
            const { detail } = event as ProjectMovedEvent;
            if (detail?.chatId === chatId) {
                finishProjectMove(detail.projectId ?? null);
            }
        };
        window.addEventListener("beaver:chat-project-moved", onProjectMoved);
        return () =>
            window.removeEventListener("beaver:chat-project-moved", onProjectMoved);
    }, [chatId, finishProjectMove, projectId]);

    const historyTitle = chats?.find(({ id }) => id === chatId)?.title;
    return {
        ...assistant,
        chatLoaded: loadedChat !== undefined,
        chatTitle: historyTitle ?? loadedChat?.title ?? null,
        chatOwnerId: loadedChat?.user_id ?? null,
        chatProjectId: projectId ??
            (movedProject ? movedProject.id : loadedChat?.project_id) ?? null,
        chatProjectName: projectId ? null : movedProject?.name ?? null,
        changeProject: async (nextProjectId: string | null) => {
            const updated = await updateChatProject(chatId, nextProjectId);
            finishProjectMove(updated.project_id);
        },
    };
}

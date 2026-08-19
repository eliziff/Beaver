import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
    BeaverApiError,
    getProject,
    updateChatProject,
} from "@/app/lib/beaverApi";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAssistantChat } from "./useAssistantChat";

type ProjectLocation = { id: string | null; name: string | null };
const chatPath = (chatId: string, projectId: string | null) =>
    projectId ? `/projects/${projectId}/assistant/chat/${chatId}` : `/assistant/chat/${chatId}`;

export function useAssistantChatRoute({
    chatId,
    projectId,
}: {
    chatId: string;
    projectId?: string;
}) {
    const navigate = useNavigate();
    const { chats } = useChatHistoryContext();
    const [movedProject, setMovedProject] =
        useState<ProjectLocation | null>(null);
    const assistant = useAssistantChat({ chatId, projectId: projectId ?? movedProject?.id ?? undefined });
    const responseLoading = assistant.state.run !== null;
    const pendingProjectRouteRef = useRef<string | null | undefined>(undefined);
    const finishProjectMove = useCallback((nextProjectId: string | null, defer = true) => {
            if (!projectId) {
                setMovedProject({ id: nextProjectId, name: null });
                if (nextProjectId) {
                    void getProject(nextProjectId)
                        .then(({ name }) => setMovedProject({ id: nextProjectId, name }))
                        .catch(() => {});
                }
            }
            if (defer && responseLoading) {
                pendingProjectRouteRef.current = nextProjectId;
            } else {
                navigate(chatPath(chatId, nextProjectId), { replace: true });
            }
        },
        [chatId, navigate, projectId, responseLoading],
    );
    useEffect(() => {
        let cancelled = false;
        const load = assistant.chatLoad;
        if (load.status === "loaded" && !projectId && load.chat?.project_id && movedProject?.id !== load.chat.project_id) {
            const nextProjectId = load.chat.project_id;
            navigate(chatPath(chatId, nextProjectId), { replace: true });
            void getProject(nextProjectId)
                .then(({ name }) => !cancelled && setMovedProject({ id: nextProjectId, name }))
                .catch(() => {});
        } else if (load.status === "error" && load.error instanceof BeaverApiError && load.error.status === 404) {
            navigate(projectId ? `/projects/${projectId}/assistant` : "/assistant", { replace: true });
        }
        return () => { cancelled = true; };
    }, [assistant.chatLoad, chatId, movedProject?.id, navigate, projectId]);
    useEffect(() => {
        const nextProjectId = pendingProjectRouteRef.current;
        if (assistant.state.run || nextProjectId === undefined) return;
        pendingProjectRouteRef.current = undefined;
        navigate(chatPath(chatId, nextProjectId), { replace: true });
    }, [assistant.state.run, chatId, navigate]);
    useEffect(() => {
        if (projectId) return;
        const onProjectMoved = (event: Event) => {
            const { detail } = event as CustomEvent<{ chatId?: string; projectId?: string | null }>;
            if (detail?.chatId === chatId) {
                finishProjectMove(detail.projectId ?? null);
            }
        };
        window.addEventListener("beaver:chat-project-moved", onProjectMoved);
        return () =>
            window.removeEventListener("beaver:chat-project-moved", onProjectMoved);
    }, [chatId, finishProjectMove, projectId]);

    const historyTitle = chats?.find(({ id }) => id === chatId)?.title;
    const loadedChat = assistant.chatLoad.status === "loaded" ? assistant.chatLoad.chat : null;
    return {
        ...assistant,
        chatLoaded: assistant.chatLoad.status === "loaded",
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

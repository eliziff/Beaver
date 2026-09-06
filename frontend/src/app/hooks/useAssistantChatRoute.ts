import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getProject } from "@/app/lib/api/projects";
import { BeaverApiError } from "@/app/lib/api/client";
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
    const { chats, onProjectMove, moveChat } = useChatHistoryContext();
    const [movedProject, setMovedProject] =
        useState<ProjectLocation | null>(null);
    const assistant = useAssistantChat({ chatId, projectId: projectId ?? movedProject?.id ?? undefined });
    const responseLoading = assistant.state.run !== null;
    const pendingProjectRouteRef = useRef<string | null | undefined>(undefined);
    const handleProjectMove = useEffectEvent((movedChatId: string, nextProjectId: string | null) => {
            if (movedChatId !== chatId) return;
            if (!projectId) {
                setMovedProject({ id: nextProjectId, name: null });
                if (nextProjectId) {
                    void getProject(nextProjectId)
                        .then(({ name }) => setMovedProject((current) =>
                            current?.id === nextProjectId ? { id: nextProjectId, name } : current))
                        .catch(() => {});
                }
            }
            if (responseLoading) {
                pendingProjectRouteRef.current = nextProjectId;
            } else {
                navigate(chatPath(chatId, nextProjectId), { replace: true });
            }
        });
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
    useEffect(() => onProjectMove((id, nextProjectId) => handleProjectMove(id, nextProjectId)), [onProjectMove]);

    const historyTitle = chats?.find(({ id }) => id === chatId)?.title;
    const loadedChat = assistant.chatLoad.status === "loaded" ? assistant.chatLoad.chat : null;
    return {
        ...assistant,
        chatLoaded: assistant.chatLoad.status === "loaded",
        chatTitle: historyTitle ?? loadedChat?.title ?? null,
        chatOwnerId: loadedChat?.user_id ?? null,
        chatModel: loadedChat?.model ?? null,
        chatReasoningEffort: loadedChat?.reasoning_effort ?? null,
        chatProjectId: projectId ??
            (movedProject ? movedProject.id : loadedChat?.project_id) ?? null,
        chatProjectName: projectId ? null : movedProject?.name ?? null,
        changeProject: (nextProjectId: string | null) => moveChat(chatId, nextProjectId),
    };
}

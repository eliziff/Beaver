"use client";
import { useState } from "react";
import { useParams } from "next/navigation";
import { useAssistantChatRoute } from "@/app/hooks/useAssistantChatRoute";
import { ChatView } from "@/app/components/assistant/ChatView";
import { SelectAssistantProjectModal } from "@/app/components/assistant/SelectAssistantProjectModal";
export default function AssistantChatPage() {
    const id = useParams<{ id: string }>().id;
    const [projectModalOpen, setProjectModalOpen] = useState(false);
    const {
        messages,
        isResponseLoading,
        handleChat,
        rejectedTurn,
        clearRejectedTurn,
        retryRejectedTurn,
        cancel,
        chatTitle,
        chatProjectId: projectId,
        chatProjectName: projectName,
        changeProject,
    } = useAssistantChatRoute({
        chatId: id,
    });
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
                projectId={projectId ?? undefined}
                projectName={projectName}
                useDisplayedDocumentContext={!!projectId}
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

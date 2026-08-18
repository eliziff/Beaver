"use client";
import { useState } from "react";
import { useParams } from "next/navigation";
import { useAssistantChatRoute } from "@/app/hooks/useAssistantChatRoute";
import { ChatView } from "@/app/components/assistant/ChatView";
import { SelectAssistantProjectModal } from "@/app/components/assistant/SelectAssistantProjectModal";
export default function AssistantChatPage() {
    const id = useParams<{ id: string }>().id;
    return <AssistantChat key={id} id={id} />;
}
function AssistantChat({ id }: { id: string }) {
    const [projectModalOpen, setProjectModalOpen] = useState(false);
    const {
        state: session,
        actions,
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
                session={session}
                handleChat={actions.handleChat}
                cancel={actions.cancel}
                onRejectedTurnRestored={actions.clearRejectedTurn}
                onRetryRejectedTurn={() => void actions.retryRejectedTurn()}
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

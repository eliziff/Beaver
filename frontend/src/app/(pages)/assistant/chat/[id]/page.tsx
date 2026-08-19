import { useState } from "react";
import { useParams } from "react-router-dom";
import { useAssistantChatRoute } from "@/app/hooks/useAssistantChatRoute";
import { ChatView } from "@/app/components/assistant/ChatView";
import { SelectAssistantProjectModal } from "@/app/components/assistant/SelectAssistantProjectModal";
export default function AssistantChatPage() {
    const { id = "" } = useParams<{ id: string }>();
    return <AssistantChat key={id} id={id} />;
}
function AssistantChat({ id }: { id: string }) {
    const [projectModalOpen, setProjectModalOpen] = useState(false);
    const {
        state: session,
        actions,
        chatTitle,
        chatLoaded,
        chatProjectId: projectId,
        chatProjectName: projectName,
        changeProject,
    } = useAssistantChatRoute({
        chatId: id,
    });
    return (
        <>
            <div className="relative h-full">
                <div inert={chatLoaded ? undefined : true} className="h-full">
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
                </div>
                {!chatLoaded && (
                    <p
                        role="status"
                        className="absolute inset-0 z-40 grid place-items-center bg-white text-sm text-gray-500"
                    >
                        Loading conversation…
                    </p>
                )}
            </div>
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

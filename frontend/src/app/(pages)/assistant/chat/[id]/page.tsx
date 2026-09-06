import { ChatLoadingState } from "@/app/components/assistant/ChatLoadingState";
import { useState } from "react";
import { takeNewChatDocuments } from "@/app/components/assistant/assistantLaunch";
import { useLocation, useParams } from "react-router-dom";
import { useAssistantChatRoute } from "@/app/hooks/useAssistantChatRoute";
import { ChatView } from "@/app/components/assistant/ChatView";
import { SelectAssistantProjectModal } from "@/app/components/assistant/SelectAssistantProjectModal";
export default function AssistantChatPage() {
    const { id = "" } = useParams<{ id: string }>();
    return <AssistantChat key={id} id={id} />;
}
function AssistantChat({ id }: { id: string }) {
    const search = new URLSearchParams(useLocation().search);
    const [initialDocuments] = useState(takeNewChatDocuments);
    const [projectModalOpen, setProjectModalOpen] = useState(false);
    const {
        state: session,
        actions,
        chatTitle,
        chatLoaded,
        chatLoad,
        chatModel,
        chatReasoningEffort,
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
                        ready={chatLoaded}
                        researchFileId={chatLoad.status === "loaded" ? chatLoad.chat?.research_file_id : undefined}
                        researchSelection={chatLoad.status === "loaded" ? chatLoad.chat?.research_selection : undefined}
                        initialDocuments={initialDocuments}
                        searchMessageId={search.get("message")}
                        session={session}
                        handleChat={actions.handleChat}
                        cancel={actions.cancel}
                        onRejectedTurnRestored={actions.clearRejectedTurn}
                        onRetryRejectedTurn={() => void actions.retryRejectedTurn()}
                        projectId={projectId ?? undefined}
                        projectName={projectName}
                        useDisplayedDocumentContext={!!projectId}
                        initialModel={chatModel}
                        initialDraft={chatLoad.status === "loaded" ? chatLoad.chat?.draft ?? null : null}
                        initialReasoningEffort={chatReasoningEffort}
                        onProjectClick={() => setProjectModalOpen(true)}
                    />
                </div>
                <ChatLoadingState load={chatLoad} onRetry={actions.retryLoad} />
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

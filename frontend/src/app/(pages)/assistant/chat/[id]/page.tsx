import { ChatLoadingState } from "@/app/components/assistant/ChatLoadingState";
import { useState } from "react";
import { takeNewChatDocuments } from "@/app/components/assistant/assistantLaunch";
import { useLocation, useParams } from "react-router-dom";
import { useAssistantChatRoute } from "@/app/hooks/useAssistantChatRoute";
import { ChatView } from "@/app/components/assistant/ChatView";
export default function AssistantChatPage() {
    const { id = "" } = useParams<{ id: string }>();
    return <AssistantChat key={id} id={id} />;
}
function AssistantChat({ id }: { id: string }) {
    const search = new URLSearchParams(useLocation().search);
    const [initialDocuments] = useState(takeNewChatDocuments);
    const {
        actions,
        chatTitle,
        chatLoaded,
        chatLoad,
        chatViewProps,
        chatProjectId: projectId,
        chatProjectName: projectName,
        changeProject,
    } = useAssistantChatRoute({
        chatId: id,
    });
    return (
        <div className="relative h-full">
            <div inert={chatLoaded ? undefined : true} className="h-full">
                <ChatView
                    {...chatViewProps}
                    initialDocuments={initialDocuments}
                    searchMessageId={search.get("message")}
                    projectId={projectId ?? undefined}
                    projectName={projectName}
                    chatTitle={chatTitle}
                    onProjectChange={changeProject}
                    useDisplayedDocumentContext={!!projectId}
                />
            </div>
            <ChatLoadingState load={chatLoad} onRetry={actions.retryLoad} />
        </div>
    );
}

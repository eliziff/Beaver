import { WorkflowPickerContent } from "../workflows/WorkflowPickerContent";
import { useWorkflowPickerState } from "../workflows/WorkflowPickerModal";
import { useNavigate } from "react-router-dom";
import { workflowPath, type WorkflowSelection } from "../workflows/workflowRoutes";

export function AssistantWorkflowDock({
    onSelect,
    initialWorkflowId,
}: {
    onSelect: (selection: WorkflowSelection) => void;
    initialWorkflowId?: string;
}) {
    const state = useWorkflowPickerState(initialWorkflowId);
    const navigate = useNavigate();
    return (
        <div className="flex h-full min-h-0 flex-col p-3">
            <WorkflowPickerContent
                workflows={state.workflows}
                onSelect={(workflow, variant) => {
                    if (variant) onSelect({ workflow, variant });
                    else navigate(workflowPath(workflow));
                }}
                search={state.search}
                onSearchChange={state.setSearch}
                audience={state.audience}
                onAudienceChange={state.setAudience}
                loading={state.loading}
                execution="assistant"
                initialWorkflowId={initialWorkflowId}
            />
        </div>
    );
}

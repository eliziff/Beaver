import { useParams } from "react-router-dom";
import { WorkflowDetailPage } from "@/app/components/workflows/WorkflowDetailPage";

export default function AssistantWorkflowPage() {
    const { id = "" } = useParams<{ id: string }>();
    return <WorkflowDetailPage id={id} workflowType="assistant" />;
}

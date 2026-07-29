import { WorkflowDetailPage } from "@/app/components/workflows/WorkflowDetailPage";
export default async function AssistantWorkflowPage({
    params,
}: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <WorkflowDetailPage id={id} workflowType="assistant" />;
}

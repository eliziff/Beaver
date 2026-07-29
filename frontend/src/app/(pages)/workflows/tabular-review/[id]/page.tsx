import { WorkflowDetailPage } from "@/app/components/workflows/WorkflowDetailPage";
export default async function TabularReviewWorkflowPage({
    params,
}: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <WorkflowDetailPage id={id} workflowType="tabular" />;
}

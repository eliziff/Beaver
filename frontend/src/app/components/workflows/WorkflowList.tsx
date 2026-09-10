import { QuoteReviewModal } from "./QuoteReviewModal";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { deleteWorkflow, type Workflow } from "@/app/lib/api/workflows";
import { createTabularReviewPath } from "../tabular/tabularReviewRoute";

import { PageHeader } from "../shared/PageHeader";
import { RowActions } from "../shared/RowActions";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { WorkflowPickerContent } from "./WorkflowPickerContent";
import { assistantWorkflowLaunch, workflowPath, type WorkflowSelection } from "./workflowRoutes";
import { WarningPopup } from "../popups/WarningPopup";
import { useWorkflowPickerState } from "./WorkflowPickerModal";

import { FIX_SUPRAS, useAssistantDocumentOperation } from "./useAssistantDocumentOperation";

export function WorkflowList() {
    const navigate = useNavigate();
    const [quoteCheck, setQuoteCheck] = useState<Workflow | null>(null);
    const supras = useAssistantDocumentOperation(FIX_SUPRAS);
    const [params] = useSearchParams();
    const initialWorkflowId = params.get("workflow") ?? undefined;
    const picker = useWorkflowPickerState(initialWorkflowId);
    const { workflows, setWorkflows, loading } = picker;
    const [creating, setCreating] = useState(false);
    const [launching, setLaunching] = useState(false);
    const [launchError, setLaunchError] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<{ workflow: Workflow; loading: boolean } | null>(null);
    async function choose(workflow: Workflow, variant?: WorkflowSelection["variant"]) {
        if (!variant && workflow.launcher.kind === "quote_check") { setQuoteCheck(workflow); return; }
        if (workflow.launcher.kind === "fix_supras") { supras.launch(); return; }
        if (!variant) return navigate(workflowPath(workflow));
        const selection = { workflow, variant };
        if (variant.execution === "assistant") {
            navigate("/assistant", { state: assistantWorkflowLaunch(selection) });
            return;
        }
        if (launching) return;
        setLaunching(true); setLaunchError(null);
        try {
            navigate(await createTabularReviewPath({
                title: variant.label,
                document_ids: [],
                columns_config: variant.columns_config ?? [],
                workflow_id: workflow.id,
            }));
        } catch {
            setLaunchError("The review could not be created. Please try again.");
        } finally { setLaunching(false); }
    }
    async function remove() {
        if (!deleting) return;
        setDeleting({ ...deleting, loading: true });
        try {
            await deleteWorkflow(deleting.workflow.id);
            setWorkflows((items) => items.filter(({ id }) => id !== deleting.workflow.id));
            setDeleting(null);
        } catch { setDeleting({ ...deleting, loading: false }); }
    }
    return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden max-[40rem]:h-auto max-[40rem]:overflow-visible">
        <PageHeader shrink loading={loading} actions={[
            { type: "new", onClick: () => setCreating(true), title: "New workflow" },
        ]}><h1 className="font-serif text-2xl font-medium text-gray-900">Workflows</h1></PageHeader>
        <div className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col px-4 pb-6 pt-2 max-[40rem]:flex-none md:px-6">
            <WorkflowPickerContent workflows={workflows} onSelect={choose}
                {...picker.pickerProps}
                initialWorkflowId={initialWorkflowId}
                audienceTabVariant="dock"
                disabledItem={() => launching}
                workflowAction={(workflow) => workflow.is_system ? null : <RowActions
                    label={`${workflow.metadata.title} actions`}
                    onEditDetails={() => navigate(workflowPath(workflow))}
                    onDelete={() => setDeleting({ workflow, loading: false })}
                    deleteLabel="Delete workflow" />} />
        </div>
        {supras.picker}
        {quoteCheck && <QuoteReviewModal workflow={quoteCheck} onClose={() => setQuoteCheck(null)}
            onAssistantSelect={({ workflow, variant }) => void choose(workflow, variant)} />}
        <NewWorkflowModal open={creating} onClose={() => setCreating(false)}
            onCreated={(workflow) => {
                setCreating(false); setWorkflows((items) => [workflow, ...items]);
                navigate(workflowPath(workflow));
            }} />
        <ConfirmPopup open={Boolean(deleting)} title="Delete workflow?"
            message="This permanently deletes the workflow."
            confirmLabel="Delete workflow"
            confirmStatus={deleting?.loading ? "loading" : "idle"}
            onConfirm={() => void remove()} onCancel={() => setDeleting(null)} />
        <WarningPopup open={!!launchError} message={launchError ?? ""}
            onClose={() => setLaunchError(null)} />
    </div>;
}

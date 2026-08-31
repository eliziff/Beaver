import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { createTabularReview, deleteWorkflow, listTabularReviews,
    listWorkProducts } from "@/app/lib/beaverApi";
import type { Workflow } from "../shared/types";
import { PageHeader } from "../shared/PageHeader";
import { RowActions } from "../shared/RowActions";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { WorkflowPickerContent } from "./WorkflowPickerContent";
import { assistantWorkflowLaunch, workflowPath, type WorkflowSelection } from "./workflowRoutes";
import { WarningPopup } from "../popups/WarningPopup";
import { useWorkflowPickerState } from "./WorkflowPickerModal";
type Resume = { id: string; title: string; destination: string; updatedAt: string; to: string };

export function WorkflowList() {
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const initialWorkflowId = params.get("workflow") ?? undefined;
    const [continued, setContinued] = useState<Resume[]>([]);
    const picker = useWorkflowPickerState(initialWorkflowId);
    const { workflows, setWorkflows, audience, setAudience, search, setSearch,
        loading } = picker;
    const [creating, setCreating] = useState(false);
    const [launching, setLaunching] = useState(false);
    const [launchError, setLaunchError] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<{ workflow: Workflow; loading: boolean } | null>(null);
    useEffect(() => {
        const reviews = listTabularReviews({ limit: 50 }).then(({ items }) => items
            .filter(({ workflow_id }) => Boolean(workflow_id)).slice(0, 8)
            .map((review) => ({ id: review.id, title: review.title || "Untitled review",
                destination: "Table", updatedAt: review.updated_at ?? review.created_at,
                to: review.project_id ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                    : `/tabular-reviews/${review.id}` }))).catch(() => []);
        const products = Promise.all([listWorkProducts("court-record"), listWorkProducts("authorities")])
            .then((items) => items.flat().map((product) => ({ id: product.id, title: product.title,
                destination: product.kind === "court-record" ? "Court Records" : "Authorities",
                updatedAt: product.updatedAt, to: `${product.kind === "court-record"
                    ? "/court-records" : "/table-of-authorities"}?draft=${encodeURIComponent(product.id)}` })))
            .catch(() => []);
        void Promise.all([reviews, products]).then((items) => setContinued(items.flat()
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 8)));
    }, []);
    async function choose(workflow: Workflow, variant?: WorkflowSelection["variant"]) {
        if (!variant) return navigate(workflowPath(workflow));
        const selection = { workflow, variant };
        if (variant.execution === "assistant") {
            navigate("/assistant", { state: assistantWorkflowLaunch(selection) });
            return;
        }
        if (launching) return;
        setLaunching(true); setLaunchError(null);
        try {
            const review = await createTabularReview({
                title: workflow.metadata.title,
                document_ids: [],
                columns_config: variant.columns_config ?? [],
                workflow_id: workflow.id,
            });
            navigate(`/tabular-reviews/${review.id}`);
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
    return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <PageHeader shrink loading={loading} actions={[
            { type: "new", onClick: () => setCreating(true), title: "New workflow" },
        ]}><h1 className="font-serif text-2xl font-medium text-gray-900">Workflows</h1></PageHeader>
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-2 md:px-6">
            {continued.length > 0 && <details className="mb-3 shrink-0">
                <summary className="group flex min-h-10 cursor-pointer items-center rounded-md px-2 text-sm font-medium text-gray-800 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">Continue working
                    <ChevronDown className="ms-auto size-4 text-gray-400 motion-safe:transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <div className="space-y-0.5 ps-5">{continued.map((item) =>
                    <Link key={`${item.destination}:${item.id}`} data-workflow-draft-id={item.id}
                        to={item.to} aria-label={`Resume ${item.title} in ${item.destination}`}
                        className="flex min-h-10 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
                        <span className="min-w-0 flex-1 truncate font-medium text-gray-800">{item.title}</span>
                        <span className="shrink-0 text-xs text-gray-500">{item.destination}</span>
                    </Link>)}</div>
            </details>}
            <WorkflowPickerContent workflows={workflows} onSelect={choose}
                search={search} onSearchChange={setSearch}
                audience={audience} onAudienceChange={setAudience}
                loading={loading} initialWorkflowId={initialWorkflowId}
                disabledItem={() => launching}
                workflowAction={(workflow) => workflow.is_system ? null : <RowActions
                    label={`${workflow.metadata.title} actions`}
                    onEditDetails={() => navigate(workflowPath(workflow))}
                    onDelete={() => setDeleting({ workflow, loading: false })}
                    deleteLabel="Delete workflow" />} />
        </div>
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

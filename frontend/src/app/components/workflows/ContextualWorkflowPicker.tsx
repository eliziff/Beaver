import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
    createAuthorities,
    createWorkProduct,
    fixLibraryDocxSupras,
    inspectDocxWorkflowCapabilities,
    type DeterministicDocxActionResult,
} from "@/app/lib/beaverApi";
import { courtRecordDraftFromDocuments } from "@/app/court-records/draftState";
import { publishWorkflowRun, workflowOperationLabel } from "../assistant/WorkflowRun";
import { WorkflowSkeuoIcon } from "../shared/AppSidebarSkeuoIcons";
import type { Document, WorkflowOperationName } from "../shared/types";
import { Button } from "../ui/button";
import { Modal } from "../modals/Modal";
import { cn } from "@/app/lib/utils";
import { WorkflowPickerContent } from "./WorkflowPickerContent";
import { useWorkflowPickerState } from "./WorkflowPickerModal";
import { workflowPath, type WorkflowSelection } from "./workflowRoutes";
import { createTabularReviewPath } from "../tabular/tabularReviewRoute";

export type WorkflowDocument = Pick<Document, "id" | "filename"> &
    Partial<Pick<Document, "file_type" | "library_kind" | "project_id">>;
export type AssistantWorkflowSelect = (
    selection: WorkflowSelection,
    documents: WorkflowDocument[],
) => void;

type PickerProps = {
    documents?: WorkflowDocument[];
    initialWorkflowId?: string;
    onAssistantSelect?: AssistantWorkflowSelect;
    onDocumentChanged?: (result: DeterministicDocxActionResult) => Promise<void> | void;
    onLaunched?: () => void;
    className?: string;
};

function documentType({ filename, file_type }: WorkflowDocument) {
    const type = file_type?.trim().toLowerCase();
    if (type === "pdf" || type === "docx") return type;
    return filename.toLowerCase().match(/\.(pdf|docx)$/u)?.[1] ?? type ?? "";
}
const sharedProjectId = (documents: WorkflowDocument[]) => documents[0]?.project_id &&
    documents.every(({ project_id }) => project_id === documents[0].project_id)
    ? documents[0].project_id : undefined;

export function ContextualWorkflowPicker({ documents = [], initialWorkflowId,
    onAssistantSelect, onDocumentChanged, onLaunched, className }: PickerProps) {
    const state = useWorkflowPickerState(initialWorkflowId);
    const navigate = useNavigate();
    const [launching, setLaunching] = useState<"table" | "product" | "supras" | null>(null);
    const [launchError, setLaunchError] = useState<string | null>(null);
    const [inspection, setInspection] = useState<{
        documentId: string; supras?: boolean; error?: boolean;
    } | null>(null);
    const [inspectionAttempt, setInspectionAttempt] = useState(0);
    const docx = documents.length === 1 && documentType(documents[0]) === "docx" &&
        documents[0].library_kind !== "template" ? documents[0] : null;
    const docxId = docx?.id;

    useEffect(() => {
        if (!docxId) { setInspection(null); return; }
        let active = true;
        setInspection(null);
        void inspectDocxWorkflowCapabilities(docxId)
            .then(({ supra_references }) => {
                if (active) setInspection({ documentId: docxId,
                    supras: supra_references === true });
            })
            .catch(() => { if (active) setInspection({ documentId: docxId, error: true }); });
        return () => { active = false; };
    }, [docxId, inspectionAttempt]);

    const contextLabel = documents.length === 1 ? documents[0].filename
        : documents.length ? `${documents.length} documents` : undefined;

    async function choose(selection: WorkflowSelection) {
        if (selection.variant.execution === "assistant") {
            if (!onAssistantSelect) return;
            onAssistantSelect(selection, documents);
            onLaunched?.();
            return;
        }
        if (launching) return;
        setLaunching("table"); setLaunchError(null);
        try {
            const projectId = sharedProjectId(documents);
            const path = await createTabularReviewPath({
                title: selection.variant.label,
                document_ids: documents.map(({ id }) => id),
                columns_config: selection.variant.columns_config ?? [],
                workflow_id: selection.workflow.id,
                ...(projectId && { project_id: projectId }),
            });
            onLaunched?.();
            navigate(path);
        } catch {
            setLaunchError("Unable to create the table. Try again.");
        } finally { setLaunching(null); }
    }

    async function openProduct(workflow: (typeof state.workflows)[number]) {
        if (launching) return;
        if (workflow.launcher.kind === "court_records" && documents.length) {
            if (documents.some((document) => document.library_kind === "template" ||
                !/^(pdf|docx)$/u.test(documentType(document)))) {
                setLaunchError("Court Records accepts PDF or Word files.");
                return;
            }
            setLaunching("product"); setLaunchError(null);
            try {
                const projectId = sharedProjectId(documents);
                const product = await createWorkProduct({ kind: "court-record",
                    title: "Untitled court record", projectId,
                    state: courtRecordDraftFromDocuments(documents) });
                onLaunched?.();
                navigate(`/court-records?draft=${encodeURIComponent(product.id)}`);
            } catch {
                setLaunchError("Unable to create Court Records. Try again.");
            } finally { setLaunching(null); }
            return;
        }
        const source = documents.length === 1 && documents[0].library_kind !== "template" &&
            /^(pdf|docx)$/u.test(documentType(documents[0]))
            ? documents[0] : null;
        if (workflow.launcher.kind !== "authorities" || !source) {
            onLaunched?.();
            navigate(workflowPath(workflow));
            return;
        }
        setLaunching("product"); setLaunchError(null);
        try {
            const product = await createAuthorities({
                source: { kind: "document", documentId: source.id, version: "latest" },
                projectId: source.project_id,
            });
            onLaunched?.();
            navigate(`/table-of-authorities?draft=${encodeURIComponent(product.id)}`);
        } catch {
            setLaunchError("Unable to create Authorities. Try again.");
        } finally { setLaunching(null); }
    }

    async function fixSupras() {
        if (!docx || launching) return;
        const tool: Extract<WorkflowOperationName, "fix_docx_supras"> = "fix_docx_supras";
        const id = `drafting:${docx.id}`;
        setLaunching("supras"); setLaunchError(null);
        publishWorkflowRun({ type: "workflow_run", id, tool, status: "running",
            stage: workflowOperationLabel(tool) });
        try {
            const result = await fixLibraryDocxSupras(docx.id);
            publishWorkflowRun({
                type: "workflow_run", id, tool, status: result.ok ? "complete" : "error",
                stage: workflowOperationLabel(tool),
                counts: [["Found", result.detected], ["Fixed", result.converted],
                    ["Already linked", result.already_linked],
                    ["Needs review", result.review_required]].flatMap(([label, value]) =>
                    typeof value === "number" ? [{ label: String(label), value }] : []),
                outputs: result.filename ? [{ name: result.filename }] : undefined,
            });
            await onDocumentChanged?.(result);
            onLaunched?.();
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to fix supra references.";
            publishWorkflowRun({ type: "workflow_run", id, tool, status: "error",
                stage: workflowOperationLabel(tool), error: message });
            setLaunchError(`${message} Try again.`);
        } finally { setLaunching(null); }
    }

    const draftingAction = (workflowId: string) => {
        if (workflowId !== "drafting" || !docx || inspection?.documentId !== docx.id) return null;
        if (inspection.error) return <button type="button"
            onClick={() => setInspectionAttempt((attempt) => attempt + 1)}
            className="mt-1 min-h-9 shrink-0 rounded-md border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
            Retry document check
        </button>;
        if (!inspection.supras) return null;
        return <button type="button" disabled={!!launching} onClick={() => void fixSupras()}
            className="mt-1 flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:cursor-not-allowed disabled:opacity-45">
            {launching === "supras" ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                : <RefreshCw className="size-3.5" aria-hidden="true" />}
            Fix supras
        </button>;
    };

    return <div className={cn("flex h-full min-h-0 flex-col", className)}>
        {launchError && <p role="alert"
            className="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
            {launchError}
        </p>}
        <WorkflowPickerContent workflows={state.workflows}
            onSelect={(workflow, variant) => {
                if (variant) void choose({ workflow, variant });
                else void openProduct(workflow);
            }}
            search={state.search} onSearchChange={state.setSearch}
            audience={state.audience} onAudienceChange={state.setAudience}
            loading={state.loading} loadError={state.loadError}
            onRetryLoad={state.retryLoad} initialWorkflowId={initialWorkflowId}
            contextLabel={contextLabel} disabledItem={(_, variant) => !!launching ||
                variant?.execution === "assistant" && !onAssistantSelect}
            workflowAction={(workflow) => draftingAction(workflow.id)} />
    </div>;
}

export function ContextualWorkflowLauncher({ documents = [], onAssistantSelect,
    onDocumentChanged, onOpen, className, labelClassName = "hidden sm:inline",
    disabled = false, showDisabled = false }: Pick<PickerProps, "documents" | "onAssistantSelect" |
        "onDocumentChanged"> & { onOpen?: (documents: WorkflowDocument[]) => void;
            className?: string; labelClassName?: string; disabled?: boolean;
            showDisabled?: boolean }) {
    const [open, setOpen] = useState(false);
    const available = !!documents?.length;
    if (!available && !showDisabled) return null;
    return <>
        <Button variant="outline" size="compact" className={cn("h-8", className)}
            disabled={disabled || !available}
            aria-label="Workflows" onClick={(event) => {
                event.stopPropagation();
                if (onOpen) onOpen(documents);
                else setOpen(true);
            }}>
            <WorkflowSkeuoIcon className="text-base leading-none" />
            <span className={labelClassName}>Workflows</span>
        </Button>
        {!onOpen && <Modal open={open} onClose={() => setOpen(false)} size="xl"
            breadcrumbs={["Workflows"]}>
            <ContextualWorkflowPicker documents={documents}
                onAssistantSelect={onAssistantSelect}
                onDocumentChanged={onDocumentChanged}
                onLaunched={() => setOpen(false)} className="pb-4" />
        </Modal>}
    </>;
}

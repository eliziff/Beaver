import { QuoteReviewModal } from "./QuoteReviewModal";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { createAuthorities } from "@/app/lib/api/authorities";
import type { Document } from "@/app/lib/api/documents";
import { FIX_SUPRAS, useAssistantDocumentOperation } from "./useAssistantDocumentOperation";
import { WorkflowSkeuoIcon } from "../shared/AppSidebarSkeuoIcons";

import type { Workflow } from "@/app/lib/api/workflows";
import { Button } from "../ui/button";
import { Modal } from "../modals/Modal";
import { WarningPopup } from "../popups/WarningPopup";
import { cn } from "@/app/lib/utils";
import { WorkflowPickerContent } from "./WorkflowPickerContent";
import { useWorkflowPickerState } from "./WorkflowPickerModal";
import { workflowPath, type WorkflowSelection } from "./workflowRoutes";
import { createTabularReviewPath } from "../tabular/tabularReviewRoute";

export type WorkflowDocument = Pick<Document, "id" | "filename"> &
    Partial<Pick<Document, "file_type" | "library_kind" | "project_id" | "current_version_id" | "folder_id">>;

type PickerProps = {
    onRun?: NonNullable<Parameters<typeof useAssistantDocumentOperation>[1]>["onRun"];
    documents?: WorkflowDocument[];
    initialWorkflowId?: string;
    onAssistantSelect?: (selection: WorkflowSelection, documents: WorkflowDocument[]) => void;
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
    onAssistantSelect, onRun, onLaunched, className }: PickerProps) {
    const state = useWorkflowPickerState(initialWorkflowId);
    const navigate = useNavigate();
    const [quoteCheck, setQuoteCheck] = useState<Workflow | null>(null);
    const [launching, setLaunching] = useState<"table" | "product" | null>(null);
    const [launchError, setLaunchError] = useState<string | null>(null);
    const supras = useAssistantDocumentOperation(FIX_SUPRAS, { onRun, onLaunched });
    const docx = documents.length === 1 && documentType(documents[0]) === "docx" &&
        documents[0].library_kind !== "template" ? documents[0] : null;

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
        if (workflow.launcher.kind === "quote_check") { setQuoteCheck(workflow); return; }
        if (workflow.launcher.kind === "fix_supras") { supras.launch(docx); return; }
        if (workflow.launcher.kind === "court_records" && documents.length) {
            if (documents.some((document) => document.library_kind === "template" ||
                !/^(pdf|docx)$/u.test(documentType(document)))) {
                setLaunchError("Court Records accepts PDF or Word files.");
                return;
            }
            const projectId = sharedProjectId(documents);
            onLaunched?.();
            navigate(`/court-records${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`,
                { state: { documents: documents.map(({ id, filename }) => ({ id, filename })) } });
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
            navigate(`/table-of-authorities?draft=${encodeURIComponent(product.id)}${source.project_id
                ? `&project=${encodeURIComponent(source.project_id)}` : ""}`);
        } catch {
            setLaunchError("Unable to create Authorities. Try again.");
        } finally { setLaunching(null); }
    }

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
            {...state.pickerProps} initialWorkflowId={initialWorkflowId}
            contextLabel={contextLabel} disabledItem={(_, variant) => !!launching || supras.launching ||
                variant?.execution === "assistant" && !onAssistantSelect}
            />
        {supras.picker}
        {quoteCheck && <QuoteReviewModal workflow={quoteCheck} documents={documents}
            onClose={() => setQuoteCheck(null)} onAssistantSelect={onAssistantSelect ? (selection, picked) => {
                if (picked.length) onAssistantSelect(selection, picked as WorkflowDocument[]); else void choose(selection); } : undefined} />}
    </div>;
}

export function ContextualWorkflowLauncher<T extends WorkflowDocument>({ documents = [], onAssistantSelect,
    onOpen, className, labelClassName = "hidden sm:inline",
    disabled = false, resolveDocuments }: {
            documents?: T[];
            onAssistantSelect?: (selection: WorkflowSelection, documents: T[]) => void;
            onOpen?: (documents: T[]) => void;
            className?: string; labelClassName?: string; disabled?: boolean;
            resolveDocuments?: () => Promise<T[]> }) {
    const [open, setOpen] = useState(false);
    const [resolved, setResolved] = useState<T[]>([]);
    const [resolving, setResolving] = useState(false);
    const [resolveError, setResolveError] = useState("");
    return <>
        <Button variant="outline" size="compact" className={cn("h-8", className)}
            disabled={disabled || resolving}
            aria-label="Workflows" onClick={async (event) => {
                event.stopPropagation();
                setResolveError("");
                if (documents.length || !resolveDocuments) {
                    if (onOpen) onOpen(documents);
                    else { setResolved(documents); setOpen(true); }
                    return;
                }
                setResolving(true);
                try {
                    const selected = await resolveDocuments?.() ?? [];
                    if (onOpen) onOpen(selected);
                    else { setResolved(selected); setOpen(true); }
                } catch {
                    setResolveError("The documents could not be opened. Try again.");
                } finally { setResolving(false); }
            }}>
            {resolving ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                : <WorkflowSkeuoIcon className="text-base leading-none" />}
            <span className={labelClassName}>Workflows</span>
        </Button>
        {!onOpen && <Modal open={open} onClose={() => setOpen(false)} size="xl"
            breadcrumbs={["Workflows"]}>
            <ContextualWorkflowPicker documents={documents.length ? documents : resolved}
                onAssistantSelect={onAssistantSelect
                    ? (selection, selected) => onAssistantSelect(selection, selected as T[])
                    : undefined}
                onLaunched={() => setOpen(false)} className="pb-4" />
        </Modal>}
        <WarningPopup open={!!resolveError} onClose={() => setResolveError("")}
            message={resolveError} />
    </>;
}

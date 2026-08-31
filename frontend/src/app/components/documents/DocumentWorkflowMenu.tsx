import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { BookOpen, Loader2, RefreshCw, X } from "lucide-react";
import {
    createAuthorities,
    fixLibraryDocxSupras,
    inspectDocxWorkflowCapabilities,
    type DeterministicDocxActionResult,
} from "@/app/lib/beaverApi";
import type { AuthoritiesProduct } from "@/app/authorities/types";
import type {
    WorkflowRunEvent,
    WorkflowOperationName,
} from "@/app/components/shared/types";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import {
    publishWorkflowRun,
    workflowOperationLabel,
} from "@/app/components/assistant/WorkflowRun";
import { WorkflowSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
export type DocumentWorkflowTarget = {
    id: string;
    filename: string;
    file_type?: string | null;
    library_kind?: "file" | "template";
    project_id?: string | null;
};
type WorkflowAction = {
    id: "authorities" | "drafting";
    tool: Extract<WorkflowOperationName,
      "create_table_of_authorities" | "fix_docx_supras">;
    icon: ComponentType<{ className?: string }>;
};
type ExternalAction = { label: string; onSelect: () => void };
type Props = {
    document: DocumentWorkflowTarget | null;
    showWhenUnavailable?: boolean;
    embedded?: boolean;
    compact?: boolean;
    label?: string;
    actions?: ExternalAction[];
    onDocumentChanged?: (result: DeterministicDocxActionResult) => Promise<void> | void;
};
type MenuState = { documentId: string; showSupras?: boolean; error?: string };
const WORKFLOWS: readonly WorkflowAction[] = [
    { id: "authorities", tool: "create_table_of_authorities", icon: BookOpen },
    { id: "drafting", tool: "fix_docx_supras", icon: RefreshCw },
];
function documentWorkflowKind(
    document: DocumentWorkflowTarget | null,
): "docx" | "pdf" | null {
    if (!document || document.library_kind === "template") return null;
    const type = document.file_type?.trim().toLowerCase();
    if (type === "docx" || type === "pdf") return type;
    const match = document.filename.trim().toLowerCase().match(/\.(docx|pdf)$/);
    return (match?.[1] as "docx" | "pdf" | undefined) ?? null;
}
export function documentWorkflowEligible(
    document: DocumentWorkflowTarget | null,
) {
    return documentWorkflowKind(document) !== null;
}
async function inspectMenu(document: DocumentWorkflowTarget): Promise<MenuState> {
    try {
        const showSupras = documentWorkflowKind(document) === "pdf" ? false
            : (await inspectDocxWorkflowCapabilities(document.id)).supra_references === true;
        return { documentId: document.id, showSupras };
    } catch (error) {
        return { documentId: document.id, error: error instanceof Error
            ? error.message : "Could not inspect this document." };
    }
}
function docxRun(
    id: string,
    tool: Extract<WorkflowOperationName, "fix_docx_supras">,
    result: DeterministicDocxActionResult,
): WorkflowRunEvent {
    const counts = [
        ["Found", result.detected],
        ["Fixed", result.converted],
        ["Already linked", result.already_linked],
        ["Needs review", result.review_required],
    ];
    return {
        type: "workflow_run",
        id,
        tool,
        status: result.ok ? "complete" : "error",
        stage: workflowOperationLabel(tool),
        counts: counts.flatMap(([label, value]) =>
            typeof value === "number"
                ? [{ label: String(label), value }]
                : [],
        ),
        outputs: result.filename ? [{ name: result.filename }] : undefined,
    };
}
function authoritiesRun(
    id: string,
    product: AuthoritiesProduct,
): WorkflowRunEvent {
    return {
        type: "workflow_run",
        id,
        tool: "create_table_of_authorities",
        status: "complete",
        stage: "Ready to review",
        progress: 100,
        counts: [{ label: "Authorities", value: product.state.authorityOrder.length }],
        app_url: `/table-of-authorities?draft=${encodeURIComponent(product.id)}`,
    };
}
export function DocumentWorkflowMenu({
    document: target,
    onDocumentChanged,
    showWhenUnavailable = false,
    embedded = false,
    compact = false,
    label = "Workflows",
    actions = [],
}: Props) {
    const document = documentWorkflowEligible(target) ? target : null;
    const [menu, setMenu] = useState<MenuState | null>(null);
    const [inspecting, setInspecting] = useState(false);
    const [running, setRunning] = useState<WorkflowOperationName | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLElement>(null);
    const currentMenu = document && menu?.documentId === document.id ? menu : null;
    const open = !!currentMenu && !currentMenu.error;
    const inspectionError = currentMenu?.error ?? "";
    const pdf = documentWorkflowKind(document) === "pdf";
    const closeMenu = (restoreFocus = true) => {
        setMenu(null);
        if (restoreFocus)
            requestAnimationFrame(() => triggerRef.current?.focus());
    };
    useEffect(() => {
        if (!embedded || !document) return;
        let active = true;
        setMenu(null);
        setInspecting(true);
        void inspectMenu(document).then((next) => { if (active) setMenu(next); })
            .finally(() => { if (active) setInspecting(false); });
        return () => { active = false; };
    }, [document, embedded, pdf]);
    useEffect(() => {
        if (!open || embedded) return;
        const frame = requestAnimationFrame(() =>
            panelRef.current?.querySelector<HTMLButtonElement>(
                "[data-workflow-id]",
            )?.focus());
        return () => cancelAnimationFrame(frame);
    }, [embedded, open]);
    async function openWorkflowMenu() {
        if (!document || inspecting) return;
        setInspecting(true);
        setMenu(null);
        setMenu(await inspectMenu(document));
        setInspecting(false);
    }
    async function runWorkflow({ id, tool }: WorkflowAction) {
        if (!document) return;
        const runId = `${id}:${document.id}`;
        setRunning(tool);
        closeMenu();
        publishWorkflowRun({
            type: "workflow_run",
            id: runId,
            tool,
            status: "running",
            stage: workflowOperationLabel(tool),
        });
        try {
            if (tool === "create_table_of_authorities") {
                publishWorkflowRun(
                    authoritiesRun(
                        runId,
                        await createAuthorities({
                            source: { kind: "document", documentId: document.id,
                                version: "latest" },
                            projectId: document.project_id,
                        }),
                    ),
                );
                return;
            }
            const result = await fixLibraryDocxSupras(document.id);
            publishWorkflowRun(docxRun(runId, tool, result));
            try {
                await onDocumentChanged?.(result);
            } catch {
                // The completed run remains available even if the view cannot refresh.
            }
        } catch (error) {
            publishWorkflowRun({
                type: "workflow_run",
                id: runId,
                tool,
                status: "error",
                stage: workflowOperationLabel(tool),
                error:
                    error instanceof Error
                        ? error.message
                        : "Workflow failed.",
            });
        } finally {
            setRunning(null);
        }
    }
    const workflows = WORKFLOWS.filter(
        ({ tool }) =>
            tool === "create_table_of_authorities" ||
            (!pdf &&
                (tool !== "fix_docx_supras" || currentMenu?.showSupras)),
    );
    const choices = <div className="grid gap-1 p-2">
        {!embedded && actions.map((action) => <button key={action.label} type="button"
            onClick={() => { closeMenu(false); action.onSelect(); }}
            className="flex min-h-10 w-full items-center rounded-md px-2.5 text-left text-sm font-medium text-gray-900 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
            {action.label}
        </button>)}
        {workflows.map((workflow) => {
            const { id, tool, icon: Icon } = workflow;
            return <button key={tool} type="button" data-workflow-id={id}
                disabled={!!running} onClick={() => void runWorkflow(workflow)}
                className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
                <Icon className="h-4 w-4 shrink-0" />
                {workflowOperationLabel(tool)}
            </button>;
        })}
    </div>;
    if (!document && !showWhenUnavailable) return null;
    return (
        <>
            {!embedded && <button
                ref={triggerRef}
                type="button"
                aria-busy={inspecting}
                aria-expanded={open}
                aria-haspopup="true"
                disabled={!document || !!running || inspecting}
                onClick={(event) => {
                    event.stopPropagation();
                    void openWorkflowMenu();
                }}
                aria-label={label}
                className={`flex h-8 items-center justify-center gap-1 rounded-md border border-gray-950 bg-gray-950 px-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${compact ? "w-8" : "w-[6.5rem]"}`}
            >
                <span className="flex h-4 w-4 items-center justify-center">
                    {inspecting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <WorkflowSkeuoIcon className="text-base leading-none" />
                    )}
                </span>
                <span className={compact ? "sr-only" : undefined}>{label}</span>
            </button>}
            <WarningPopup
                open={!!inspectionError}
                onClose={() => setMenu(null)}
                title="Workflows unavailable"
                message={inspectionError}
            />
            {open && (embedded ? (
                <div className="h-full overflow-y-auto bg-white">
                    <p className="break-all border-b border-gray-200 px-4 py-3 text-sm text-gray-600">
                        {document?.filename}
                    </p>
                    {choices}
                </div>
            ) : createPortal(
                    <aside
                        ref={panelRef}
                        aria-label="Workflows"
                        data-shortcut-layer
                        data-shortcut-open="true"
                        className="fixed right-4 top-16 z-[210] max-h-[calc(100vh-5rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-gray-300 bg-white shadow-md"
                    >
                        <div className="sticky top-0 z-10 flex h-12 items-center border-b border-gray-200 bg-white px-4">
                            <h2 className="min-w-0 flex-1 text-sm font-semibold text-gray-950">
                                {label}
                            </h2>
                            <button
                                type="button"
                                data-shortcut-close
                                onClick={() => closeMenu()}
                                aria-label="Close workflows"
                                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 hover:text-gray-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        {choices}
                    </aside>,
                    globalThis.document.body,
                ))}
        </>
    );
}

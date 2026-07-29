import { createPortal } from "react-dom";
import { useState, type ComponentType } from "react";
import { BookOpen, Link2, Loader2, RefreshCw, WandSparkles, X } from "lucide-react";
import { isAnonymousMode } from "@/app/lib/authMode";
import {
    fixLibraryDocxSupras,
    inspectLibraryDocumentAutomation,
    linkLibraryDocxCitations,
    submitLibraryDocumentToAuthorities,
    type DeterministicDocxActionResult,
    type TableOfAuthoritiesJob,
} from "@/app/lib/beaverApi";
import type {
    AutomationRunEvent,
    AutomationToolName,
} from "@/app/components/shared/types";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import {
    automationLabel,
    publishAutomationRun,
} from "@/app/components/assistant/AutomationRun";
type DocumentAutomationTarget = {
    id: string;
    filename: string;
    file_type?: string | null;
    library_kind?: "file" | "template";
    project_id?: string | null;
};
type Action = {
    tool: Exclude<AutomationToolName, "toa_job_status">;
    icon: ComponentType<{ className?: string }>;
};
const ACTIONS: readonly Action[] = [
    { tool: "toa_submit_library_document", icon: BookOpen },
    { tool: "library_link_docx_citations", icon: Link2 },
    { tool: "library_fix_docx_supras", icon: RefreshCw },
];
export function documentAutomationEligible(
    document: DocumentAutomationTarget | null,
) {
    if (!document) return false;
    if (document.library_kind === "template") return false;
    return (
        document.file_type?.trim().toLowerCase() === "docx" ||
        document.filename.trim().toLowerCase().endsWith(".docx")
    );
}
function docxRun(
    id: string,
    tool: Extract<
        AutomationToolName,
        "library_fix_docx_supras" | "library_link_docx_citations"
    >,
    result: DeterministicDocxActionResult,
): AutomationRunEvent {
    const counts =
        tool === "library_fix_docx_supras"
            ? [
                  ["Found", result.detected],
                  ["Fixed", result.converted],
                  ["Already linked", result.already_linked],
                  ["Needs review", result.review_required],
              ]
            : [
                  ["Linked", result.linked_citations],
                  ["Unresolved", result.unresolved_citations],
              ];
    return {
        type: "automation_run",
        id,
        tool,
        status: result.ok ? "complete" : "error",
        stage: automationLabel(tool),
        counts: counts.flatMap(([label, value]) =>
            typeof value === "number"
                ? [{ label: String(label), value }]
                : [],
        ),
        outputs: result.filename ? [{ name: result.filename }] : undefined,
        document_id: result.document_id,
        version_id: result.version_id,
    };
}
function authoritiesRun(
    id: string,
    documentId: string,
    job: TableOfAuthoritiesJob,
): AutomationRunEvent {
    return {
        type: "automation_run",
        id,
        tool: "toa_submit_library_document",
        status: job.state || "queued",
        stage: job.operation || "Submitted",
        progress: job.progress,
        message: job.message || undefined,
        counts: job.files.length
            ? [{ label: "Outputs", value: job.files.length }]
            : undefined,
        error: job.error || undefined,
        outputs: job.files.map(({ name, url }) => ({ name, url })),
        app_url: job.app_url,
        job_id: job.id,
        document_id: documentId,
    };
}
export function DocumentAutomation({
    document,
    onDocumentChanged,
    showWhenUnavailable = false,
}: {
    document: DocumentAutomationTarget | null;
    showWhenUnavailable?: boolean;
    onDocumentChanged?: (
        result: DeterministicDocxActionResult,
    ) => Promise<void> | void;
}) {
    if (!isAnonymousMode) return null;
    const eligibleDocument = documentAutomationEligible(document)
        ? document
        : null;
    if (!eligibleDocument && !showWhenUnavailable) return null;
    return (
        <DocumentAutomationMenu
            document={eligibleDocument}
            onDocumentChanged={onDocumentChanged}
        />
    );
}
function DocumentAutomationMenu({
    document,
    onDocumentChanged,
}: {
    document: DocumentAutomationTarget | null;
    onDocumentChanged?: (
        result: DeterministicDocxActionResult,
    ) => Promise<void> | void;
}) {
    const [menu, setMenu] = useState<{
        documentId: string;
        showSupras: boolean;
    } | null>(null);
    const [inspecting, setInspecting] = useState(false);
    const [running, setRunning] = useState<AutomationToolName | null>(null);
    const [failure, setFailure] = useState<{
        documentId: string;
        message: string;
    } | null>(null);
    const open = !!document && menu?.documentId === document.id;
    const inspectionError =
        document && failure?.documentId === document.id ? failure.message : "";
    async function openAutomation() {
        if (!document || inspecting) return;
        setInspecting(true);
        setFailure(null);
        try {
            const capabilities = await inspectLibraryDocumentAutomation(
                document.id,
            );
            setMenu({
                documentId: document.id,
                showSupras: capabilities.supra_references === true,
            });
        } catch (error) {
            setFailure({
                documentId: document.id,
                message:
                    error instanceof Error
                        ? error.message
                        : "Could not inspect this document.",
            });
        } finally {
            setInspecting(false);
        }
    }
    async function runAction(tool: Action["tool"]) {
        if (!document) return;
        const runId = `${tool}:${document.id}`;
        setRunning(tool);
        setMenu(null);
        publishAutomationRun({
            type: "automation_run",
            id: runId,
            tool,
            status: "running",
            stage: automationLabel(tool),
            document_id: document.id,
        });
        try {
            if (tool === "toa_submit_library_document") {
                publishAutomationRun(
                    authoritiesRun(
                        runId,
                        document.id,
                        await submitLibraryDocumentToAuthorities(
                            document.id,
                            "auto",
                            document.project_id,
                        ),
                    ),
                );
                return;
            }
            const result =
                tool === "library_fix_docx_supras"
                    ? await fixLibraryDocxSupras(document.id)
                    : await linkLibraryDocxCitations(document.id);
            publishAutomationRun(docxRun(runId, tool, result));
            try {
                await onDocumentChanged?.(result);
            } catch {}
        } catch (error) {
            publishAutomationRun({
                type: "automation_run",
                id: runId,
                tool,
                status: "error",
                stage: automationLabel(tool),
                error:
                    error instanceof Error
                        ? error.message
                        : "Automation failed.",
                document_id: document.id,
            });
        } finally {
            setRunning(null);
        }
    }
    const actions = ACTIONS.filter(
        ({ tool }) =>
            tool !== "library_fix_docx_supras" || menu?.showSupras,
    );
    return (
        <>
            <button
                type="button"
                aria-busy={inspecting}
                disabled={!document || !!running || inspecting}
                onClick={(event) => {
                    event.stopPropagation();
                    void openAutomation();
                }}
                className="flex h-8 w-[6.5rem] items-center justify-center gap-1 rounded-md border border-gray-300 bg-white px-1.5 text-xs font-medium text-gray-800 hover:border-gray-500 hover:bg-gray-50 disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400"
            >
                <span className="flex h-4 w-4 items-center justify-center">
                    {inspecting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <WandSparkles className="h-4 w-4" />
                    )}
                </span>
                Automation
            </button>
            <WarningPopup
                open={!!inspectionError}
                onClose={() => setFailure(null)}
                title="Automation unavailable"
                message={inspectionError}
            />
            {open &&
                createPortal(
                    <aside
                        aria-label="Automation"
                        data-shortcut-layer
                        data-shortcut-open="true"
                        className="fixed right-4 top-16 z-[210] max-h-[calc(100vh-5rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-gray-300 bg-white shadow-md"
                    >
                        <div className="sticky top-0 z-10 flex h-12 items-center border-b border-gray-200 bg-white px-4">
                            <h2 className="min-w-0 flex-1 text-sm font-semibold text-gray-950">
                                Automation
                            </h2>
                            <button
                                type="button"
                                data-shortcut-close
                                onClick={() => setMenu(null)}
                                aria-label="Close Automation"
                                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 hover:text-gray-950"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="grid gap-1 p-2">
                            {actions.map(({ tool, icon: Icon }) => (
                                <button
                                    key={tool}
                                    type="button"
                                    disabled={!!running}
                                    onClick={() => void runAction(tool)}
                                    className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-50"
                                >
                                    <Icon className="h-4 w-4 shrink-0" />
                                    {automationLabel(tool)}
                                </button>
                            ))}
                        </div>
                    </aside>,
                    globalThis.document.body,
                )}
        </>
    );
}

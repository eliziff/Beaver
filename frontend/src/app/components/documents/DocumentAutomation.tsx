import { createPortal } from "react-dom";
import { useEffect, useState, type ComponentType } from "react";
import { BookOpen, Loader2, RefreshCw, WandSparkles, X } from "lucide-react";
import { isLocalMode } from "@/app/lib/authMode";
import {
    fixLibraryDocxSupras,
    inspectLibraryDocumentAutomation,
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
export type DocumentAutomationTarget = {
    id: string;
    filename: string;
    file_type?: string | null;
    library_kind?: "file" | "template";
    project_id?: string | null;
};
type Action = {
    tool: AutomationToolName;
    icon: ComponentType<{ className?: string }>;
};
const ACTIONS: readonly Action[] = [
    { tool: "create_table_of_authorities", icon: BookOpen },
    { tool: "fix_docx_supras", icon: RefreshCw },
];
function documentAutomationKind(
    document: DocumentAutomationTarget | null,
): "docx" | "pdf" | null {
    if (!document || document.library_kind === "template") return null;
    const type = document.file_type?.trim().toLowerCase();
    if (type === "docx" || type === "pdf") return type;
    const match = document.filename.trim().toLowerCase().match(/\.(docx|pdf)$/);
    return (match?.[1] as "docx" | "pdf" | undefined) ?? null;
}
export function documentAutomationEligible(
    document: DocumentAutomationTarget | null,
) {
    return documentAutomationKind(document) !== null;
}
function docxRun(
    id: string,
    tool: Extract<AutomationToolName, "fix_docx_supras">,
    result: DeterministicDocxActionResult,
): AutomationRunEvent {
    const counts = [
        ["Found", result.detected],
        ["Fixed", result.converted],
        ["Already linked", result.already_linked],
        ["Needs review", result.review_required],
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
        tool: "create_table_of_authorities",
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
    embedded = false,
}: {
    document: DocumentAutomationTarget | null;
    showWhenUnavailable?: boolean;
    embedded?: boolean;
    onDocumentChanged?: (
        result: DeterministicDocxActionResult,
    ) => Promise<void> | void;
}) {
    if (!isLocalMode) return null;
    const eligibleDocument = documentAutomationEligible(document)
        ? document
        : null;
    if (!eligibleDocument && !showWhenUnavailable) return null;
    return (
        <DocumentAutomationMenu
            document={eligibleDocument}
            onDocumentChanged={onDocumentChanged}
            embedded={embedded}
        />
    );
}
function DocumentAutomationMenu({
    document,
    onDocumentChanged,
    embedded,
}: {
    document: DocumentAutomationTarget | null;
    embedded: boolean;
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
    const pdf = documentAutomationKind(document) === "pdf";
    useEffect(() => {
        if (!embedded || !document) return;
        let active = true;
        setFailure(null);
        if (pdf) {
            setMenu({ documentId: document.id, showSupras: false });
            return;
        }
        setInspecting(true);
        void inspectLibraryDocumentAutomation(document.id)
            .then((capabilities) => {
                if (active)
                    setMenu({
                        documentId: document.id,
                        showSupras: capabilities.supra_references === true,
                    });
            })
            .catch((error: unknown) => {
                if (active)
                    setFailure({
                        documentId: document.id,
                        message:
                            error instanceof Error
                                ? error.message
                                : "Could not inspect this document.",
                    });
            })
            .finally(() => {
                if (active) setInspecting(false);
            });
        return () => {
            active = false;
        };
    }, [document, embedded, pdf]);
    async function openAutomation() {
        if (!document || inspecting) return;
        if (pdf) {
            setFailure(null);
            setMenu({ documentId: document.id, showSupras: false });
            return;
        }
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
            if (tool === "create_table_of_authorities") {
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
            const result = await fixLibraryDocxSupras(document.id);
            publishAutomationRun(docxRun(runId, tool, result));
            try {
                await onDocumentChanged?.(result);
            } catch {
                // The completed automation remains available even if the view cannot refresh.
            }
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
            tool === "create_table_of_authorities" ||
            (!pdf &&
                (tool !== "fix_docx_supras" || menu?.showSupras)),
    );
    return (
        <>
            {!embedded && <button
                type="button"
                aria-busy={inspecting}
                disabled={!document || !!running || inspecting}
                onClick={(event) => {
                    event.stopPropagation();
                    void openAutomation();
                }}
                className="flex h-8 w-[6.5rem] items-center justify-center gap-1 rounded-md border border-gray-950 bg-gray-950 px-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400"
            >
                <span className="flex h-4 w-4 items-center justify-center">
                    {inspecting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <WandSparkles className="h-4 w-4" />
                    )}
                </span>
                Automation
            </button>}
            <WarningPopup
                open={!!inspectionError}
                onClose={() => setFailure(null)}
                title="Automation unavailable"
                message={inspectionError}
            />
            {open && (embedded ? (
                <div className="h-full overflow-y-auto bg-white">
                    <p className="border-b border-gray-200 px-4 py-3 text-sm text-gray-600">
                        {document.filename}
                    </p>
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
                </div>
            ) : createPortal(
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
                ))}
        </>
    );
}

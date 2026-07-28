"use client";

import { createPortal } from "react-dom";
import { useEffect, useState, type ComponentType } from "react";
import { BookOpen, Link2, Loader2, RefreshCw, X } from "lucide-react";
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
    AutomationRunPanel,
    automationLabel,
} from "./AutomationRun";

export type DocumentAutomationTarget = {
    id: string;
    filename: string;
    file_type?: string | null;
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
    return (
        document.file_type?.trim().toLowerCase() === "docx" ||
        document.filename.trim().toLowerCase().endsWith(".docx")
    );
}

function docxRun(
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
        id: `${tool}:${result.version_id}`,
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
    documentId: string,
    job: TableOfAuthoritiesJob,
): AutomationRunEvent {
    return {
        type: "automation_run",
        id: `toa:${job.id}`,
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
}: {
    document: DocumentAutomationTarget | null;
    onDocumentChanged?: (
        result: DeterministicDocxActionResult,
    ) => Promise<void> | void;
}) {
    if (
        !isAnonymousMode ||
        !document ||
        !documentAutomationEligible(document)
    ) {
        return null;
    }
    return (
        <DocumentAutomationMenu
            document={document}
            onDocumentChanged={onDocumentChanged}
        />
    );
}

function DocumentAutomationMenu({
    document,
    onDocumentChanged,
}: {
    document: DocumentAutomationTarget;
    onDocumentChanged?: (
        result: DeterministicDocxActionResult,
    ) => Promise<void> | void;
}) {
    const [open, setOpen] = useState(false);
    const [inspecting, setInspecting] = useState(false);
    const [showSupras, setShowSupras] = useState(false);
    const [running, setRunning] = useState<AutomationToolName | null>(null);
    const [run, setRun] = useState<AutomationRunEvent | null>(null);
    const [inspectionError, setInspectionError] = useState("");

    useEffect(() => {
        setOpen(false);
        setRun(null);
        setInspectionError("");
    }, [document.id]);

    async function openAutomation() {
        if (inspecting) return;
        setInspecting(true);
        setInspectionError("");
        try {
            const capabilities = await inspectLibraryDocumentAutomation(
                document.id,
            );
            setShowSupras(capabilities.supra_references === true);
            setOpen(true);
        } catch (error) {
            setInspectionError(
                error instanceof Error
                    ? error.message
                    : "Could not inspect this document.",
            );
        } finally {
            setInspecting(false);
        }
    }

    async function runAction(tool: Action["tool"]) {
        setRunning(tool);
        setRun({
            type: "automation_run",
            id: `${tool}:running`,
            tool,
            status: "running",
            stage: automationLabel(tool),
            document_id: document.id,
        });
        try {
            if (tool === "toa_submit_library_document") {
                setRun(
                    authoritiesRun(
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
            setRun(docxRun(tool, result));
            try {
                await onDocumentChanged?.(result);
            } catch {}
        } catch (error) {
            setRun({
                type: "automation_run",
                id: `${tool}:error`,
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
        ({ tool }) => tool !== "library_fix_docx_supras" || showSupras,
    );

    return (
        <>
            <button
                type="button"
                aria-busy={inspecting}
                disabled={inspecting}
                onClick={(event) => {
                    event.stopPropagation();
                    void openAutomation();
                }}
                className="flex h-8 min-w-[6.5rem] items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-800 hover:border-gray-500 hover:bg-gray-50 disabled:text-gray-500"
            >
                <span className="flex h-4 w-4 items-center justify-center">
                    {inspecting && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                </span>
                Automation
            </button>
            <WarningPopup
                open={!!inspectionError}
                onClose={() => setInspectionError("")}
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
                                onClick={() => setOpen(false)}
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
                                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                        {running === tool ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Icon className="h-4 w-4" />
                                        )}
                                    </span>
                                    {automationLabel(tool)}
                                </button>
                            ))}
                        </div>
                        {run && (
                            <div className="border-t border-gray-200">
                                <AutomationRunPanel run={run} />
                            </div>
                        )}
                    </aside>,
                    globalThis.document.body,
                )}
        </>
    );
}

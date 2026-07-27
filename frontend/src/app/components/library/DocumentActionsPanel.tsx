"use client";

import { createPortal } from "react-dom";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
    ExternalLink,
    FileCheck2,
    FileSearch,
    Link2,
    Loader2,
    Maximize2,
    Minus,
    PanelLeft,
    PanelRight,
    Wrench,
    X,
} from "lucide-react";
import type {
    Document,
    PdfParseState,
    PdfParseStatus,
} from "@/app/components/shared/types";
import {
    useSelectedModel,
    useSelectedReasoningEffort,
} from "@/app/hooks/useSelectedModel";
import { PillButton } from "@/app/components/ui/pill-button";
import { isAnonymousMode } from "@/app/lib/authMode";
import { cn } from "@/app/lib/utils";
import {
    fixLibraryDocxSupras,
    getLibraryPdfParseState,
    linkLibraryDocxCitations,
    retryLibraryPdfParse,
    submitLibraryDocumentToAuthorities,
    type DeterministicDocxActionResult,
} from "@/app/lib/beaverApi";

type ActionName = "supras" | "citations" | "authorities";

const PDF_PARSE_POLL_DELAYS_MS = [
    1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000,
];
const PDF_PARSE_LABELS: Record<PdfParseStatus, string> = {
    queued: "Queued",
    parsing: "Parsing",
    ready: "Ready",
    degraded: "Degraded",
    failed: "Failed",
};

function isActivePdfParse(state: PdfParseState | null) {
    return state?.status === "queued" || state?.status === "parsing";
}

function parseDiagnosticSummary(state: PdfParseState | null) {
    if (!state?.diagnostic_count) return null;
    const severities = Object.entries(
        state.diagnostic_summary?.by_severity ?? {},
    )
        .filter(([, count]) => count > 0)
        .map(([severity, count]) => `${count} ${severity.toLowerCase()}`);
    const codes = Object.entries(state.diagnostic_summary?.by_code ?? {})
        .filter(([, count]) => count > 0)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([code]) => code.toLowerCase().replaceAll("_", " "));
    return [
        `${state.diagnostic_count} diagnostic${state.diagnostic_count === 1 ? "" : "s"}`,
        severities.join(", "),
        codes.join(", "),
    ]
        .filter(Boolean)
        .join(" · ");
}

export function DocumentActionsPanel({
    open,
    onClose,
    document,
    onDocumentChanged,
}: {
    open: boolean;
    onClose: () => void;
    document: Document | null;
    onDocumentChanged: () => Promise<void>;
}) {
    const router = useRouter();
    const [selectedModel] = useSelectedModel();
    const [selectedReasoningEffort] = useSelectedReasoningEffort();
    const [running, setRunning] = useState<ActionName | null>(null);
    const [result, setResult] =
        useState<DeterministicDocxActionResult | null>(null);
    const [error, setError] = useState("");
    const [minimized, setMinimized] = useState(false);
    const [dock, setDock] = useState<"left" | "right">("right");
    const isDocx =
        document?.file_type?.toLowerCase() === "docx" ||
        document?.filename.toLowerCase().endsWith(".docx");
    const isPdf =
        document?.file_type?.toLowerCase() === "pdf" ||
        document?.filename.toLowerCase().endsWith(".pdf");
    const documentId = document?.id ?? null;
    const pdfVersionId =
        document?.current_version_id ?? document?.pdf_parse?.version_id ?? null;
    const [pdfParse, setPdfParse] = useState<PdfParseState | null>(null);
    const [pdfParseLoading, setPdfParseLoading] = useState(false);
    const [pdfParseError, setPdfParseError] = useState("");
    const [pdfParsePollPaused, setPdfParsePollPaused] = useState(false);
    const [pdfParseRefreshKey, setPdfParseRefreshKey] = useState(0);
    const [pdfParseAction, setPdfParseAction] = useState<
        "retry" | "ocr" | "repair" | null
    >(null);

    useEffect(() => {
        setResult(null);
        setError("");
        setPdfParse(document?.pdf_parse ?? null);
        setPdfParseError("");
        setPdfParsePollPaused(false);
    }, [document?.pdf_parse, documentId, pdfVersionId]);

    useEffect(() => {
        if (!open || !isAnonymousMode || !documentId || !isPdf) return;
        const selectedDocumentId = documentId;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pollIndex = 0;
        const controller = new AbortController();

        async function refresh() {
            setPdfParseLoading(true);
            try {
                const next = await getLibraryPdfParseState(
                    selectedDocumentId,
                    pdfVersionId,
                    controller.signal,
                );
                if (stopped) return;
                setPdfParse(next);
                setPdfParseError("");
                if (!isActivePdfParse(next)) return;
                const delay = PDF_PARSE_POLL_DELAYS_MS[pollIndex];
                if (delay === undefined) {
                    setPdfParsePollPaused(true);
                    return;
                }
                pollIndex += 1;
                timer = setTimeout(() => void refresh(), delay);
            } catch (loadError) {
                if (
                    stopped ||
                    (loadError as { name?: string } | null)?.name ===
                        "AbortError"
                ) {
                    return;
                }
                setPdfParseError(
                    loadError instanceof Error
                        ? loadError.message
                        : "Could not read the structural parse state.",
                );
            } finally {
                if (!stopped) setPdfParseLoading(false);
            }
        }

        setPdfParsePollPaused(false);
        void refresh();
        return () => {
            stopped = true;
            controller.abort();
            if (timer) clearTimeout(timer);
        };
    }, [
        documentId,
        isPdf,
        open,
        pdfParseRefreshKey,
        pdfVersionId,
    ]);

    async function retryPdfParse(action: "retry" | "ocr" | "repair") {
        if (!document) return;
        if (
            action === "repair" &&
            (!selectedModel.startsWith("codex:") ||
                !selectedReasoningEffort)
        ) {
            setPdfParseError(
                "Choose a Codex model and reasoning effort in Assistant first.",
            );
            return;
        }
        setPdfParseAction(action);
        setPdfParseError("");
        try {
            const next = await retryLibraryPdfParse(
                document.id,
                pdfVersionId,
                action === "ocr"
                    ? { ocrProvider: "tesseract" }
                    : action === "repair"
                      ? {
                            repair: {
                                model: selectedModel,
                                effort: selectedReasoningEffort!,
                            },
                        }
                      : undefined,
            );
            setPdfParse(next);
            setPdfParseRefreshKey((value) => value + 1);
        } catch (retryError) {
            setPdfParseError(
                retryError instanceof Error
                    ? retryError.message
                    : "Could not retry the structural parse.",
            );
        } finally {
            setPdfParseAction(null);
        }
    }

    async function run(action: Exclude<ActionName, "authorities">) {
        if (!document) return;
        setRunning(action);
        setResult(null);
        setError("");
        try {
            const next =
                action === "supras"
                    ? await fixLibraryDocxSupras(document.id)
                    : await linkLibraryDocxCitations(document.id);
            setResult(next);
            if (next.changed !== false || next.linked_citations) {
                await onDocumentChanged();
            }
        } catch (actionError) {
            setError(
                actionError instanceof Error
                    ? actionError.message
                    : "The document action failed.",
            );
        } finally {
            setRunning(null);
        }
    }

    async function openAuthorities() {
        if (!document) return;
        setRunning("authorities");
        setResult(null);
        setError("");
        try {
            const job = await submitLibraryDocumentToAuthorities(
                document.id,
                "auto",
            );
            onClose();
            router.push(job.open_path);
        } catch (actionError) {
            setError(
                actionError instanceof Error
                    ? actionError.message
                    : "Table of Authorities submission failed.",
            );
        } finally {
            setRunning(null);
        }
    }

    if (!open) return null;

    if (minimized) {
        return createPortal(
            <div
                className={cn(
                    "fixed bottom-5 z-[180] flex max-w-[min(440px,calc(100vw-2rem))] items-center gap-1 rounded-2xl border border-gray-200 bg-white p-1.5 shadow-sm",
                    dock === "right" ? "right-5" : "left-5",
                )}
            >
                <button
                    type="button"
                    onClick={() => setMinimized(false)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs text-gray-700 transition-colors hover:bg-red-50"
                >
                    <Wrench className="h-3.5 w-3.5 shrink-0 text-red-700" />
                    <span className="truncate">
                        Document actions
                        {document ? ` — ${document.filename}` : ""}
                    </span>
                    <Maximize2 className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded-xl p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                    aria-label="Close document actions"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>,
            globalThis.document.body,
        );
    }

    return createPortal(
        <aside
            aria-label="Document actions"
            className={cn(
                "fixed bottom-5 top-20 z-[180] flex w-[min(430px,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl border border-gray-200 bg-gray-50 shadow-sm",
                dock === "right" ? "right-5" : "left-5",
            )}
        >
            <div className="flex items-center gap-2 border-b border-white/80 px-4 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-red-100 bg-red-50 text-red-700">
                    <Wrench className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-medium text-gray-900">
                        Document actions
                    </h2>
                    <p className="truncate text-[11px] text-gray-500">
                        {document?.filename ?? "Select one document"}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() =>
                        setDock((current) =>
                            current === "right" ? "left" : "right",
                        )
                    }
                    className="rounded-xl p-2 text-gray-400 transition-colors hover:bg-white hover:text-gray-700"
                    aria-label={`Dock panel on the ${dock === "right" ? "left" : "right"}`}
                    title={`Dock ${dock === "right" ? "left" : "right"}`}
                >
                    {dock === "right" ? (
                        <PanelLeft className="h-3.5 w-3.5" />
                    ) : (
                        <PanelRight className="h-3.5 w-3.5" />
                    )}
                </button>
                <button
                    type="button"
                    onClick={() => setMinimized(true)}
                    className="rounded-xl p-2 text-gray-400 transition-colors hover:bg-white hover:text-gray-700"
                    aria-label="Minimize document actions"
                    title="Minimize"
                >
                    <Minus className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded-xl p-2 text-gray-400 transition-colors hover:bg-white hover:text-gray-700"
                    aria-label="Close document actions"
                    title="Close"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="mb-4 rounded-2xl border border-red-100 bg-red-50/55 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-gray-900">
                        <Wrench className="h-4 w-4 text-red-700" />
                        Deterministic first
                    </div>
                    <p className="mt-1 text-xs leading-5 text-gray-600">
                        These actions use bounded document code before asking a
                        model. A model is used only for an ambiguity the action
                        explicitly reports, never to re-create mechanical work
                        from scratch.
                    </p>
                    <p className="mt-2 truncate text-xs text-gray-500">
                        {document
                            ? `Selected: ${document.filename}`
                            : "Select exactly one document in Library."}
                    </p>
                </div>

                <div className="space-y-3">
                    {isAnonymousMode && document && isPdf && (
                        <PdfParseCard
                            state={pdfParse}
                            loading={pdfParseLoading}
                            action={pdfParseAction}
                            pollPaused={pdfParsePollPaused}
                            error={pdfParseError}
                            onRefresh={() =>
                                setPdfParseRefreshKey((value) => value + 1)
                            }
                            onRetry={() => void retryPdfParse("retry")}
                            onOcr={() => void retryPdfParse("ocr")}
                            onRepair={() => void retryPdfParse("repair")}
                        />
                    )}
                    <ActionCard
                        icon={<FileCheck2 className="h-4 w-4" />}
                        title="Fix supra references"
                        label="Deterministic"
                        description="Finds plain “supra note N” references and turns the number into a native Word footnote cross-reference that updates when notes move. Restarted numbering, split Word runs, and invalid targets are left for review."
                        disabled={!document || !isDocx || !!running}
                        running={running === "supras"}
                        buttonLabel="Fix supras"
                        onClick={() => void run("supras")}
                    />
                    <ActionCard
                        icon={<Link2 className="h-4 w-4" />}
                        title="Link legal citations"
                        label="Deterministic + bounded fallback"
                        description="Splits footnote citations, resolves them against legal providers, verifies the destination, and writes hyperlinks into a new DOCX version. Only ambiguous citation boundaries are eligible for the bounded model splitter."
                        disabled={!document || !isDocx || !!running}
                        running={running === "citations"}
                        buttonLabel="Link citations"
                        onClick={() => void run("citations")}
                    />
                    <ActionCard
                        icon={<ExternalLink className="h-4 w-4" />}
                        title="Table or Book of Authorities"
                        label="Dedicated workspace"
                        description="Sends the selected DOCX to the maintained authorities workflow for deterministic detection, review, table generation, and optional book assembly. Ambiguous boundaries can use the same bounded citation-splitting fallback."
                        disabled={!document || !isDocx || !!running}
                        running={running === "authorities"}
                        buttonLabel="Open workspace"
                        onClick={() => void openAuthorities()}
                    />
                </div>

                {!isDocx && document && (
                    <p className="mt-3 text-xs text-amber-700">
                        Supra, citation-linking, and authorities actions
                        currently require a DOCX source.
                    </p>
                )}
                {result && (
                    <div className="mt-4 rounded-2xl border border-emerald-100 bg-emerald-50/65 p-3 text-xs text-emerald-900">
                        {result.converted !== undefined ? (
                            <>
                                Converted {result.converted} of{" "}
                                {result.detected ?? result.converted} supra
                                references
                                {result.review_required
                                    ? `; ${result.review_required} require review`
                                    : ""}
                                .{" "}
                                {result.changed === false
                                    ? "No new version was needed."
                                    : `Saved ${result.filename}.`}
                            </>
                        ) : (
                            <>
                                Linked {result.linked_citations ?? 0} citations
                                {result.unresolved_citations
                                    ? `; ${result.unresolved_citations} remain unresolved`
                                    : ""}
                                . Saved {result.filename}.
                            </>
                        )}
                    </div>
                )}
                {error && (
                    <div className="mt-4 whitespace-pre-wrap rounded-2xl border border-red-100 bg-red-50/70 p-3 text-xs text-red-700">
                        {error}
                    </div>
                )}
            </div>
        </aside>,
        globalThis.document.body,
    );
}

function PdfParseCard({
    state,
    loading,
    action,
    pollPaused,
    error,
    onRefresh,
    onRetry,
    onOcr,
    onRepair,
}: {
    state: PdfParseState | null;
    loading: boolean;
    action: "retry" | "ocr" | "repair" | null;
    pollPaused: boolean;
    error: string;
    onRefresh: () => void;
    onRetry: () => void;
    onOcr: () => void;
    onRepair: () => void;
}) {
    const active = isActivePdfParse(state);
    const ocrRequired =
        (state?.diagnostic_summary?.by_code.OCR_REQUIRED ?? 0) > 0;
    const repairAvailable = state?.structural_repair_available === true;
    const statusLabel = state
        ? PDF_PARSE_LABELS[state.status]
        : loading
          ? "Checking"
          : "Not queued";
    const statusTone =
        state?.status === "ready"
            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : state?.status === "degraded"
              ? "border-amber-200 bg-amber-50 text-amber-700"
              : state?.status === "failed"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-blue-200 bg-blue-50 text-blue-700";
    const description =
        state?.status === "queued"
            ? "The durable local parse is queued."
            : state?.status === "parsing"
              ? "Building page, paragraph, section, footnote, and proposition structure."
              : state?.status === "ready"
                ? "The structural artifacts are ready for exact lookup."
                : state?.status === "degraded"
                  ? "Partial structure is available; flat-text access remains available."
                  : state?.status === "failed"
                    ? "The structural pass failed; the source and flat-text fallback remain available."
                    : "No structural parse state exists for this PDF yet.";
    const diagnostics = parseDiagnosticSummary(state);
    const retryLabel =
        state?.status === "ready"
            ? "Reprocess structure"
            : state
              ? "Retry structural parse"
              : "Start structural parse";

    return (
        <div className="rounded-2xl border border-gray-200 bg-white/75 p-4">
            <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-red-100 bg-red-50 text-red-700">
                    {active ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <FileSearch className="h-4 w-4" />
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium text-gray-900">
                            PDF structure
                        </h3>
                        <span
                            aria-label="PDF parse status"
                            className={cn(
                                "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                                statusTone,
                            )}
                        >
                            {statusLabel}
                        </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-gray-600">
                        {description}
                    </p>
                    {state && (
                        <p className="mt-1 text-[11px] text-gray-500">
                            Attempt {state.attempts}
                            {state.page_count !== undefined
                                ? ` · ${state.page_count} page${state.page_count === 1 ? "" : "s"}`
                                : ""}
                            {state.cache_hit ? " · cache hit" : ""}
                            {state.parser_config.ocr_provider === "tesseract"
                                ? " · Tesseract OCR"
                                : ""}
                            {state.parser_config.mode === "codex"
                                ? " · Codex repair"
                                : ""}
                        </p>
                    )}
                    {diagnostics && (
                        <p className="mt-1 overflow-x-auto break-normal text-[11px] text-gray-600">
                            {diagnostics}
                        </p>
                    )}
                    {state?.error && (
                        <p className="mt-1 overflow-x-auto break-normal text-[11px] text-red-700">
                            {state.error.slice(0, 280)}
                        </p>
                    )}
                    {pollPaused && (
                        <p className="mt-1 text-[11px] text-amber-700">
                            Automatic checks paused; refresh to check again.
                        </p>
                    )}
                    {error && (
                        <p className="mt-1 overflow-x-auto break-normal text-[11px] text-red-700">
                            {error}
                        </p>
                    )}
                </div>
            </div>
            <p className="mt-3 text-[11px] leading-4 text-gray-500">
                Retry preserves parser settings. OCR and bounded structural
                repair are opt-in.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
                <PillButton
                    type="button"
                    tone="white"
                    size="normal"
                    disabled={loading || !!action}
                    onClick={onRefresh}
                    className="min-w-0 flex-1"
                >
                    {loading && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    Refresh status
                </PillButton>
                {!active && (
                    <PillButton
                        type="button"
                        tone="white"
                        size="normal"
                        disabled={loading || !!action}
                        onClick={onRetry}
                        className="min-w-0 flex-1"
                    >
                        {action === "retry" && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        {retryLabel}
                    </PillButton>
                )}
                {!active && ocrRequired && (
                    <PillButton
                        type="button"
                        tone="white"
                        size="normal"
                        disabled={loading || !!action}
                        onClick={onOcr}
                        className="col-span-2 min-w-0"
                    >
                        {action === "ocr" && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        OCR affected pages
                    </PillButton>
                )}
                {!active && repairAvailable && (
                    <PillButton
                        type="button"
                        tone="white"
                        size="normal"
                        disabled={loading || !!action}
                        onClick={onRepair}
                        title="Uses the Codex model and reasoning effort selected in Assistant. Only diagnosed pages receive bounded r=1 context."
                        className="col-span-2 min-w-0"
                    >
                        {action === "repair" && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        Repair uncertain structure
                    </PillButton>
                )}
            </div>
        </div>
    );
}

function ActionCard({
    icon,
    title,
    label,
    description,
    disabled,
    running,
    buttonLabel,
    onClick,
}: {
    icon: ReactNode;
    title: string;
    label: string;
    description: string;
    disabled: boolean;
    running?: boolean;
    buttonLabel: string;
    onClick: () => void;
}) {
    return (
        <div className="rounded-2xl border border-gray-200 bg-white/75 p-4">
            <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-red-100 bg-red-50 text-red-700">
                {icon}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium text-gray-900">
                        {title}
                    </h3>
                    <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-500">
                        {label}
                    </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-gray-600">
                    {description}
                </p>
            </div>
            </div>
            <PillButton
                type="button"
                tone="white"
                size="normal"
                disabled={disabled}
                onClick={onClick}
                className="mt-3 w-full"
            >
                {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {buttonLabel}
            </PillButton>
        </div>
    );
}

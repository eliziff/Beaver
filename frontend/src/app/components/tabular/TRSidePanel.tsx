import { useEffect, useRef, useState } from "react";
import {
    Loader2,
    PanelLeft,
    RefreshCw,
    X,
} from "lucide-react";
import type { ColumnConfig, Document, TabularCell } from "../shared/types";
import { isDocxFilename, isSpreadsheetFilename } from "../shared/types";
import type { ParsedCitation } from "./citation-utils";
import { parseTabularMarkdown, TabularMarkdown } from "./TabularMarkdown";
import { DocumentViewer } from "../shared/views/DocumentViewer";import { FileTypeIcon } from "../shared/FileTypeIcon";
import { CitationQuotesHeader } from "../assistant/CitationQuotesHeader";
import { cn } from "@/app/lib/utils";
import { LIQUID_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
interface Props {
    cell: TabularCell;
    document: Document;
    column: ColumnConfig;
    onClose: () => void;
    onRegenerate?: () => Promise<void>;
    displayDocument?: boolean;
    citationQuote?: string;
    citationPage?: number;
    citationSheet?: string;
    citationCell?: string;
    citationRef?: number;
}
type TRPanelCitation = {
    quote: string;
    page?: number;
    sheet?: string;
    cell?: string;
    citationRef?: number;
};
const FLAG_BADGE: Record<string, string> = {
    green: "bg-emerald-600 border border-emerald-700 text-white shadow-sm",
    grey: "bg-slate-500 border border-slate-600 text-white shadow-sm",
    yellow: "bg-amber-500 border border-amber-600 text-white shadow-sm",
    red: "bg-red-600 border border-red-700 text-white shadow-sm",
};
export function TRSidePanel({
    cell,
    document: doc,
    column,
    onClose,
    onRegenerate,
    displayDocument = false,
    citationQuote,
    citationPage,
    citationSheet,
    citationCell,
    citationRef,
}: Props) {
    const [regenerating, setRegenerating] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const [documentPaneOpen, setDocumentPaneOpen] = useState(displayDocument);
    const [docCitation, setDocCitation] = useState<
        TRPanelCitation | undefined
    >(
        displayDocument && citationQuote
            ? {
                  quote: citationQuote,
                  page: citationPage,
                  sheet: citationSheet,
                  cell: citationCell,
                  citationRef,
              }
            : undefined,
    );
    useEffect(() => {
        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (
                !(target instanceof Node) ||
                panelRef.current?.contains(target)
            ) {
                return;
            }
            onClose();
        };
        document.addEventListener("pointerdown", handleOutsidePointerDown);
        return () =>
            document.removeEventListener(
                "pointerdown",
                handleOutsidePointerDown,
            );
    }, [onClose]);
    function handleCitationOpen(citation: TRPanelCitation) {
        setDocCitation(citation);
        setDocumentPaneOpen(true);
    }
    const summary = parseTabularMarkdown(cell.content?.summary || "—");
    const reasoning = parseTabularMarkdown(cell.content?.reasoning ?? "");
    return (
        <div
            ref={panelRef}
            className={cn(
                "fixed bottom-3 right-3 top-3 z-100 flex max-w-[calc(100vw-1.5rem)] overflow-hidden",
                LIQUID_PANEL_SURFACE_CLASS,
                documentPaneOpen
                    ? "w-[900px] flex-col md:flex-row"
                    : "w-[300px]",
            )}
        >
            {documentPaneOpen && (
                <div
                    className="relative flex min-h-0 min-w-0 flex-1 flex-col border-b border-white/30 px-3 pb-3 md:border-b-0 md:border-r"
                >
                    <div className="flex min-h-11 shrink-0 items-center gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <FileTypeIcon
                                fileType={doc.file_type ?? doc.filename}
                                className="h-4 w-4"
                            />
                            <div
                                className="min-w-0 truncate text-sm font-medium text-gray-700"
                                title={doc.filename}
                            >
                                {doc.filename}
                            </div>
                        </div>
                    </div>
                    {docCitation?.quote && (
                        <div className="-mx-3 shrink-0 py-2">
                            <CitationQuotesHeader
                                quotes={[
                                    {
                                        id: citationKey(cell.id, docCitation),
                                        quote: docCitation.quote,
                                        inlineDetail:
                                            formatCitationLocation(docCitation),
                                        citationText: `${doc.filename}, ${formatCitationLocation(docCitation)}`,
                                    },
                                ]}
                                activeQuoteId={citationKey(
                                    cell.id,
                                    docCitation,
                                )}
                                citationRef={docCitation.citationRef}
                                citationText={`${doc.filename}, ${formatCitationLocation(docCitation)}`}
                            />
                        </div>
                    )}
                    <DocumentViewer                        documentId={doc.id}                        kind={                            (["docx", "doc"].includes((doc.file_type ?? "").toLowerCase()) || isDocxFilename(doc.filename ?? "")) && !doc.pdf_storage_path                                ? "docx"                                : isSpreadsheetFilename(doc.filename ?? "")                                  ? "spreadsheet"                                  : "pdf"                        }                        quotes={                            docCitation                                ? [                                      {                                          page: docCitation.page,                                          quote: docCitation.quote,                                      },                                  ]                                : undefined                        }                        highlightCells={                            docCitation?.sheet || docCitation?.cell                                ? [                                      {                                          sheet: docCitation.sheet,                                          cell: docCitation.cell,                                      },                                  ]                                : undefined                        }                    />                </div>
            )}
            <div
                className={cn(
                    "flex w-full shrink-0 flex-col overflow-hidden",
                    documentPaneOpen
                        ? "h-[min(320px,45%)] md:h-auto md:w-[300px]"
                        : "h-full",
                )}
            >
                <div className="mb-2 flex min-h-11 shrink-0 items-center justify-end gap-1.5 border-b border-white/30 px-3">
                    <button
                        type="button"
                        onClick={() =>
                            setDocumentPaneOpen((open) => !open)
                        }
                        className={cn(
                            "mr-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-white/75 hover:text-gray-700",
                            documentPaneOpen && "bg-white/55 text-gray-700",
                        )}
                        aria-label={
                            documentPaneOpen
                                ? "Collapse document pane"
                                : "Expand document pane"
                        }
                        title={
                            documentPaneOpen
                                ? "Collapse document pane"
                                : "Expand document pane"
                        }
                        aria-pressed={documentPaneOpen}
                    >
                        <PanelLeft className="h-4 w-4" />
                    </button>
                    {onRegenerate && (
                        <button
                            onClick={async () => {
                                setRegenerating(true);
                                try {
                                    await onRegenerate();
                                } finally {
                                    setRegenerating(false);
                                }
                            }}
                            disabled={regenerating}
                            title="Regenerate"
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
                        >
                            {regenerating ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <RefreshCw className="h-4 w-4" />
                            )}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm hover:bg-gray-50 hover:text-gray-700"
                        aria-label="Close"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto">
                    <div className="pb-2 px-5">
                        <div className="mb-4 flex min-h-8 items-center gap-2">
                            <FileTypeIcon
                                fileType={doc.file_type ?? doc.filename}
                                className="h-3.5 w-3.5"
                            />
                            <div className="min-w-0">
                                <div className="truncate text-xs font-medium text-gray-900">
                                    {column.name}
                                </div>
                                {!documentPaneOpen && (
                                    <div
                                        className="truncate text-xs text-gray-600"
                                        title={doc.filename}
                                    >
                                        {doc.filename}
                                    </div>
                                )}
                            </div>
                        </div>
                        {cell.content?.flag && (
                            <div className="mb-5">
                                <h4 className="mb-2 text-xs font-medium text-gray-900">
                                    Flag
                                </h4>
                                <span
                                    className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${FLAG_BADGE[cell.content.flag] ?? FLAG_BADGE.grey}`}
                                >
                                    {cell.content.flag.charAt(0).toUpperCase() +
                                        cell.content.flag.slice(1)}
                                </span>
                            </div>
                        )}
                        <div className="mb-6">
                            <h4 className="mb-2 text-xs font-medium text-gray-900">
                                Results
                            </h4>
                            <div className="text-xs leading-relaxed text-slate-600">
                                <TabularMarkdown
                                    parsed={summary}
                                    onCitationClick={(citation, citationRef) =>
                                        handleCitationOpen({
                                            ...citation,
                                            citationRef,
                                        })
                                    }
                                    column={column}
                                />
                            </div>
                        </div>
                        {cell.content?.reasoning && (
                            <div>
                                <h4 className="mb-2 text-xs font-medium text-gray-900">
                                    Reasoning
                                </h4>
                                <div className="text-xs leading-relaxed text-slate-600">
                                    <TabularMarkdown
                                        parsed={reasoning}
                                        onCitationClick={(
                                            citation,
                                            citationRef,
                                        ) =>
                                            handleCitationOpen({
                                                ...citation,
                                                citationRef,
                                            })
                                        }
                                        citationOffset={
                                            summary.citations.length
                                        }
                                        column={column}
                                        inline
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
function formatCitationLocation(citation: ParsedCitation): string {
    if (citation.sheet && citation.cell) {
        return `${citation.sheet}, cell ${citation.cell}`;
    }
    return `Page ${citation.page ?? 1}`;
}
function citationKey(cellId: string, citation: ParsedCitation): string {
    const location = citation.sheet
        ? `${citation.sheet}:${citation.cell ?? ""}`
        : `page:${citation.page ?? 1}`;
    return `tr-cell:${cellId}:${location}`;
}

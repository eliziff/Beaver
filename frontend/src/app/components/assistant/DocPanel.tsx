import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { apiFetch } from "@/app/lib/beaverApi";import { downloadBlob } from "@/app/lib/download";
import { PillButton } from "@/app/components/ui/pill-button";
import { DocumentViewer } from "../shared/views/DocumentViewer";import {
    CitationQuotesHeader,
    type CitationQuoteHeaderItem,
} from "./CitationQuotesHeader";
import { useEditResolution } from "./EditCard";
import { DocumentAutomation } from "@/app/components/documents/DocumentAutomation";
import {
    cleanCitationQuoteText,
    expandCitationToEntries,
    formatCitationPage,
    formatCitationQuotePage,
    getDocumentCitationQuotes,
    isDocxFilename,
    isSpreadsheetFilename,
} from "../shared/types";
import type {
    CitationQuote,
    Citation,
    DocumentCitation,
    EditAnnotation,
    EditResolveHandlers,
} from "../shared/types";
export type DocPanelMode =
    | { kind: "document" }
    | { kind: "citation"; citation: Citation }
    | ({
          kind: "edit";
          edit: EditAnnotation;
          isEditReloading?: boolean;
      } & EditResolveHandlers);
interface Props {
    documentId: string;
    filename: string;
    projectId?: string;
    versionId: string | null;
    versionNumber: number | null;
    mode: DocPanelMode;
    isReloading?: boolean;
    warning?: string | null;
    onWarningDismiss?: () => void;
    initialScrollTop?: number | null;
    onScrollChange?: (scrollTop: number) => void;
}
function useLocalOverride<T>(source: T) {
    const [override, setOverride] = useState({ source, value: source });
    return [
        override.source === source ? override.value : source,
        (value: T) => setOverride({ source, value }),
    ] as const;
}
export function DocPanel({
    documentId,
    filename,
    projectId,
    versionId,
    versionNumber,
    mode,
    isReloading = false,
    warning,
    onWarningDismiss,
    initialScrollTop,
    onScrollChange,
}: Props) {
    const useDocxView = isDocxFilename(filename);
    const useSheetView = isSpreadsheetFilename(filename);
    const [actionVersionId, setActionVersionId] = useLocalOverride(versionId);
    const citationQuoteId =
        mode.kind === "citation" ? `document:${mode.citation.ref}:0` : null;
    const [activeCitationQuoteId, setActiveCitationQuoteId] =
        useLocalOverride(citationQuoteId);
    const [quoteFocusKey, setQuoteFocusKey] = useState(0);
    const selectedQuote =
        mode.kind === "citation" && activeCitationQuoteId
            ? getDocumentCitationQuotes(mode.citation)[
                  Number(activeCitationQuoteId.split(":").at(-1))
              ]
            : undefined;
    const quotes: CitationQuote[] | undefined =
        mode.kind !== "citation"
            ? undefined
            : selectedQuote
              ? expandCitationToEntries({
                    ...(mode.citation as DocumentCitation),
                    quotes: [selectedQuote],
                })
              : [];
    const highlightCells =
        mode.kind !== "citation"
            ? undefined
            : selectedQuote && (selectedQuote.cell || selectedQuote.sheet)
              ? [{ sheet: selectedQuote.sheet, cell: selectedQuote.cell }]
              : [];
    const handleCitationQuoteSelect = (quoteId: string) => {
        const shouldSelect = activeCitationQuoteId !== quoteId;
        setActiveCitationQuoteId(shouldSelect ? quoteId : null);
        if (shouldSelect) setQuoteFocusKey((current) => current + 1);
    };
    const highlightEdit =
        mode.kind === "edit"
            ? {
                  key: mode.edit.edit_id,
                  inserted_text: mode.edit.inserted_text,
                  deleted_text: mode.edit.deleted_text,
                  ins_w_id: mode.edit.ins_w_id ?? null,
                  del_w_id: mode.edit.del_w_id ?? null,
              }
            : null;
    return (
        <div className="flex h-full flex-col">
            {mode.kind !== "edit" && (
                <DocumentTitleRow
                    documentId={documentId}
                    filename={filename}
                    projectId={projectId}
                    versionId={actionVersionId}
                    versionNumber={versionNumber}
                    isReloading={isReloading}
                    onDocumentChanged={setActionVersionId}
                />
            )}
            {mode.kind === "citation" && (
                <RelevantQuoteSection
                    citation={mode.citation}
                    filename={filename}
                    activeQuoteId={activeCitationQuoteId}
                    onQuoteSelect={handleCitationQuoteSelect}
                />
            )}
            {mode.kind === "edit" && (
                <TrackedChangeHeader {...mode} />
            )}
            <div className="flex flex-1 min-h-0 flex-col px-3 py-3">
                <DocumentViewer                    documentId={documentId}                    kind={useDocxView ? "docx" : useSheetView ? "spreadsheet" : "pdf"}                    versionId={actionVersionId}                    quotes={quotes}                    quoteFocusKey={quoteFocusKey}                    highlightEdit={highlightEdit}                    highlightCells={highlightCells}                    warning={warning ?? null}                    onWarningDismiss={onWarningDismiss}                    initialScrollTop={initialScrollTop ?? null}                    onScrollChange={onScrollChange}                />            </div>
        </div>
    );
}
function TrackedChangeHeader({
    edit,
    isEditReloading,
    ...handlers
}: Extract<DocPanelMode, { kind: "edit" }>) {
    const { status, resolve, disabled } = useEditResolution(
        edit,
        undefined,
        isEditReloading,
        handlers,
    );
    return (
        <div className="flex shrink-0 justify-end border-b border-gray-200 px-3 py-2">
            <div className="flex items-center gap-2">
                <PillButton
                    tone="black"
                    size="sm"
                    onClick={() => resolve("accept")}
                    disabled={disabled}
                >
                    {status === "accepted" ? "Accepted" : "Accept"}
                </PillButton>
                <PillButton
                    tone="white"
                    size="sm"
                    onClick={() => resolve("reject")}
                    disabled={disabled}
                >
                    {status === "rejected" ? "Rejected" : "Reject"}
                </PillButton>
            </div>
        </div>
    );
}
function DocumentTitleRow({
    documentId,
    filename,
    projectId,
    versionId,
    versionNumber,
    isReloading,
    onDocumentChanged,
}: {
    documentId: string;
    filename: string;
    projectId?: string;
    versionId: string | null;
    versionNumber: number | null;
    isReloading: boolean;
    onDocumentChanged: (versionId: string) => void;
}) {
    return (
        <div className="flex items-start gap-3 px-3 pt-4 pb-3">
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h2
                        className="min-w-0 max-w-full truncate font-serif text-xl text-gray-900"
                        title={filename}
                    >
                        {filename}
                    </h2>
                    {versionNumber && versionNumber > 0 && (
                        <span className="shrink-0 inline-flex items-center rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                            V{versionNumber}
                        </span>
                    )}
                </div>
            </div>
            <div className="shrink-0">
                <DocumentAutomation
                    document={{ id: documentId, filename, project_id: projectId }}
                    onDocumentChanged={(result) =>
                        onDocumentChanged(result.version_id)
                    }
                />
            </div>
            <div className="shrink-0">
                <DownloadButton
                    documentId={documentId}
                    versionId={versionId}
                    filename={filename}
                    isReloading={isReloading}
                />
            </div>
        </div>
    );
}
function RelevantQuoteSection({
    citation,
    filename,
    activeQuoteId,
    onQuoteSelect,
}: {
    citation: Citation;
    filename: string;
    activeQuoteId: string | null;
    onQuoteSelect: (quoteId: string) => void;
}) {
    const citationQuotes = getDocumentCitationQuotes(citation);
    const pagesLabel = formatCitationPage(citation);
    const citationText = [filename, pagesLabel].filter(Boolean).join(", ");
    const relevantQuotes: CitationQuoteHeaderItem[] = citationQuotes.map(
        (quote, index) => {
            const pageLabel = formatCitationQuotePage(
                citation,
                quote.page,
                quote,
            );
            return {
                id: `document:${citation.ref}:${index}`,
                quote: cleanCitationQuoteText(quote.quote),                inlineDetail: pageLabel || null,
                citationText: [filename, pageLabel].filter(Boolean).join(", "),
            };
        },
    );
    const currentIndex = Math.max(
        0,
        relevantQuotes.findIndex((quote) => quote.id === activeQuoteId),
    );
    return (
        <CitationQuotesHeader
            quotes={relevantQuotes}
            activeQuoteId={activeQuoteId}
            currentIndex={currentIndex}
            citationRef={citation.ref}
            citationText={citationText}
            onSelect={(quote) => onQuoteSelect(quote.id)}
            onIndexChange={(index) => {
                const quote = relevantQuotes[index];
                if (quote) onQuoteSelect(quote.id);
            }}
        />
    );
}
function DownloadButton({
    documentId,
    versionId,
    filename,
    isReloading,
}: {
    documentId: string;
    versionId: string | null;
    filename: string;
    isReloading?: boolean;
}) {
    const [busy, setBusy] = useState(false);
    const handleClick = async () => {
        if (busy || isReloading) return;
        setBusy(true);
        try {
            const qs = versionId                ? `?version_id=${encodeURIComponent(versionId)}`                : "";            const resp = await apiFetch(                `/single-documents/${documentId}/docx${qs}`,                { headers: { Accept: "*/*" } },            );            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            downloadBlob(await resp.blob(), filename);
        } finally {
            setBusy(false);
        }
    };
    const spinning = busy || isReloading;
    return (
        <PillButton tone="white" onClick={handleClick} disabled={spinning}>
            {spinning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
                <Download className="h-3.5 w-3.5" />
            )}
            Download
        </PillButton>
    );
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, PanelLeft, RefreshCw, X } from "lucide-react";
import type { ColumnConfig, TabularCell, TabularDocument } from "@/app/lib/api/tabular";
import { type Citation } from "@/app/lib/citations";
import { ResearchCitationContent } from "../legal/ResearchCitationViewer";
import { TabularResultContent } from "./TabularResultContent";
import { evidenceCitation, type GroundedEvidence } from "@/app/lib/groundedAnswers";
import type { ResearchSourceReference } from "@/app/lib/researchFiles";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { Button } from "../ui/button";
import { cn } from "@/app/lib/utils";
import { LIQUID_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
interface Props {
    cell: TabularCell;
    document: TabularDocument;
    column: ColumnConfig;
    onClose: () => void;
    onRegenerate?: () => Promise<void>;
    running?: boolean;
    displayDocument?: boolean;
    citation?: Citation;
}
const receiptReference = (receipt: GroundedEvidence): ResearchSourceReference | undefined => receipt.provider === "library" && receipt.version ? {
            provider: "library", kind: "document", id: receipt.stable_source_id, versionId: receipt.version,
            title: receipt.name ?? receipt.citation,
        } : receipt.source_reference ? {
            provider: receipt.provider, id: receipt.source_reference.id,
            family: receipt.source_reference.family, part: receipt.source_reference.part,
            kind: receipt.source_class === "legislation" ? "legislation" : receipt.provider === "journal" ? "journal" : receipt.provider === "hansard" ? "hansard" : "case",
            title: receipt.name, citation: receipt.citation, collection: receipt.dataset, url: receipt.external_url,
        } : undefined;
const COMPACT_PANEL = "(max-width: 767px)";
const ICON_BUTTON = "h-7 w-7 text-gray-500 hover:text-gray-800";
export function TRSidePanel({
    cell,
    document: doc,
    column,
    onClose,
    onRegenerate,
    running = false,
    displayDocument = false,
    citation,
}: Props) {
    const [regenerating, setRegenerating] = useState(false), [error, setError] = useState("");
    const initialEvidence = citation && cell.content?.evidence.find((receipt) =>
        JSON.stringify(evidenceCitation(receipt, citation.ref)) === JSON.stringify(citation));
    const [evidenceReference, setEvidenceReference] = useState<ResearchSourceReference | undefined>(() => initialEvidence ? receiptReference(initialEvidence) : undefined);
    const [inspectingEvidence, setInspectingEvidence] = useState(!!initialEvidence);
    const panelRef = useRef<HTMLDialogElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    const openerRef = useRef(
        document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
    );
    const [documentPaneOpen, setDocumentPaneOpen] = useState(displayDocument);
    const [docCitation, setDocCitation] = useState(citation);
    useLayoutEffect(() => {
        const panel = panelRef.current, media = window.matchMedia?.(COMPACT_PANEL);
        const opener = openerRef.current;
        if (!panel) return;
        const update = () => {
            if (panel.open) panel.close();
            if (media?.matches) {
                panel.setAttribute("aria-modal", "true");
                panel.showModal();
                closeRef.current?.focus();
            } else {
                panel.removeAttribute("aria-modal");
                panel.setAttribute("open", "");
            }
        };
        update();
        media?.addEventListener?.("change", update);
        return () => {
            media?.removeEventListener?.("change", update);
            if (panel.open) panel.close();
            if (opener?.isConnected) opener.focus();
        };
    }, []);
    useEffect(() => {
        const handleOutsidePointerDown = (event: PointerEvent) => {
            if (window.matchMedia?.(COMPACT_PANEL).matches) return;
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
    function handleCitationOpen(citation: Citation, receipt: GroundedEvidence) {
        setEvidenceReference(receiptReference(receipt));
        setInspectingEvidence(true);
        setDocCitation(citation);
        setDocumentPaneOpen(true);
    }
    const source = inspectingEvidence ? evidenceReference : doc.reference;
    const documentTitle = docCitation?.kind === "document" ? docCitation.filename : source?.title ?? (inspectingEvidence && docCitation && "citation" in docCitation ? docCitation.citation : doc.filename);
    return (
        <dialog
            ref={panelRef}
            aria-label={`${column.name} result`}
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
            className={cn(
                "fixed bottom-3 left-auto right-3 top-3 z-100 m-0 flex h-[calc(100dvh-1.5rem)] max-h-[calc(100dvh-1.5rem)] min-h-0 max-w-[calc(100vw-1.5rem)] overflow-hidden p-0 text-inherit backdrop:bg-gray-950/20",
                LIQUID_PANEL_SURFACE_CLASS,
                documentPaneOpen
                    ? "w-[1040px] flex-col md:flex-row"
                    : "w-[400px]",
                "max-md:inset-0 max-md:h-dvh max-md:max-h-none max-md:w-screen max-md:max-w-none max-md:rounded-none max-md:border-0",
            )}
        >
            {documentPaneOpen && (
                <div
                    className="relative flex min-h-0 min-w-0 flex-1 flex-col border-b border-white/30 px-3 pb-3 md:border-b-0 md:border-r"
                >
                    <div className="flex min-h-11 shrink-0 items-center gap-2">
                        <FileTypeIcon fileType={doc.file_type ?? doc.filename} className="h-4 w-4" />
                        <div className="min-w-0 truncate text-sm font-medium text-gray-700" title={documentTitle ?? undefined}>
                            {documentTitle}
                        </div>
                    </div>
                    <ResearchCitationContent document={inspectingEvidence ? undefined : doc} reference={source} citation={docCitation} />
                </div>
            )}
            <div
                className={cn(
                    "flex min-h-0 w-full shrink-0 flex-col overflow-hidden",
                    documentPaneOpen
                        ? "h-[min(360px,45%)] md:h-auto md:w-[400px]"
                        : "h-full",
                )}
            >
                <div className="mb-2 flex min-h-11 shrink-0 items-center gap-1 border-b border-white/30 px-3">
                    <Button variant="ghost" size="icon-sm" onClick={() => setDocumentPaneOpen((open) => !open)}
                        className={cn(ICON_BUTTON, "mr-auto", documentPaneOpen && "bg-gray-100 text-gray-800")}
                        aria-label={documentPaneOpen ? "Collapse document pane" : "Expand document pane"}
                        title={documentPaneOpen ? "Collapse document pane" : "Expand document pane"}
                        aria-pressed={documentPaneOpen}>
                        <PanelLeft className="h-4 w-4" />
                    </Button>
                    {onRegenerate && (
                        <Button variant="ghost" size="icon-sm" className={ICON_BUTTON}
                            onClick={async () => {
                                setRegenerating(true); setError("");
                                try {
                                    await onRegenerate();
                                } catch { setError("Could not regenerate this result. Try again."); } finally {
                                    setRegenerating(false);
                                }
                            }}
                            disabled={regenerating || running}
                            aria-label="Regenerate"
                            title={running ? "Wait for the current run to finish" : "Regenerate"}
                        >
                            {regenerating ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <RefreshCw className="h-4 w-4" />
                            )}
                        </Button>
                    )}
                    <Button ref={closeRef} variant="ghost" size="icon-sm" className={ICON_BUTTON} onClick={onClose} aria-label="Close">
                        <X className="h-4 w-4" />
                    </Button>
                </div>
                <div aria-label="Result content" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    <div className="px-5 pb-3">
                        {!documentPaneOpen && <div className="mb-1 flex items-center gap-1.5 text-xs text-gray-600">
                            <FileTypeIcon fileType={doc.file_type ?? doc.filename} className="h-3.5 w-3.5" />
                            <span className="truncate" title={doc.filename}>{doc.filename}</span>
                        </div>}
                        <h2 className="text-sm font-semibold leading-5 text-gray-900 [overflow-wrap:anywhere]">{column.name}</h2>

                        <div className="mt-3">
                            {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
                            <TabularResultContent cell={cell} column={column} onEvidence={handleCitationOpen} />
                        </div>
                    </div>
                </div>
            </div>
        </dialog>
    );
}

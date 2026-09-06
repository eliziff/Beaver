import {
    lazy,
    Suspense,
    useEffect,
    useEffectEvent,
    useLayoutEffect,
    useRef,
    useState,
    type ChangeEvent,
    type FormEvent,
} from "react";
import {
    AlertCircle,
    Check,
    ChevronDown,
    Download,
    FileDiff,
    Highlighter,
    Loader2,
    Pencil,
    RotateCcw,
    Save,
    Trash2,
    Upload,
} from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ContextualWorkflowLauncher } from "@/app/components/workflows/ContextualWorkflowPicker";
import type { WorkflowSelection } from "@/app/components/workflows/workflowRoutes";
import { Button } from "@/app/components/ui/button";
import type { Document, DocumentVersion } from "@/app/lib/api/documents";
import {
  isDocxFilename,
  isSpreadsheetFilename,
  filenameExtensionChangeWarning,
  hasFilenameExtensionChange,
} from "@/app/lib/documentFilename";
import { DocumentViewer } from "@/app/components/shared/views/DocumentViewer";
import { ReaderExpandButton } from "./ReaderExpandButton";
import { preserveReaderScroll } from "./useReaderExpansion";

import { formatBytes } from "@/app/lib/utils";
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";

import { getResearchFile, getResearchItems } from "@/app/lib/api/researchFiles";
import { ResearchLabelCircle } from "@/app/components/legal/ResearchLabelCircle";
import { useSourcesWorkspaceOrNull } from "@/app/components/legal/SourcesWorkspace";
import { useLibraryReaderCapture } from "@/app/components/shared/useLibraryReaderCapture";
import type { CitationQuote } from "@/app/lib/citations";
import {
    isResearchDocument,
    researchLabelPath,
    researchSourceKey,
    type ResearchFile,
    type ResearchSourceReference,
} from "@/app/lib/researchFiles";

const VERSION_PAGE = 40;
const PREVIEW_TEXT = 1_000;
const previewText = (text: string) => text.length > PREVIEW_TEXT ? `${text.slice(0, PREVIEW_TEXT)}…` : text;
interface Props {
    doc: Document | null;
    versionId?: string | null;
    currentVersionId?: string | null;
    versions: DocumentVersion[];
    versionsLoading: boolean;
    versionsError?: boolean;
    onClose: () => void;
    onLoadVersions: (docId: string, force?: boolean) => Promise<unknown> | void;
    onSelectVersion: (versionId: string) => void;
    onDownloadVersion: (
        docId: string,
        versionId: string,
        filename: string,
    ) => Promise<void> | void;
    onRenameDocument: (docId: string, filename: string) => Promise<void> | void;
    onCheckpointVersion: (docId: string, comment?: string) => Promise<void> | void;
    onRestoreVersion: (
        docId: string,
        versionId: string,
    ) => Promise<void> | void;
    onCompareVersions: (
        docId: string,
        baselineVersionId: string,
        versionId: string,
    ) => Promise<void> | void;
    onUploadNewVersion: (doc: Document, file: File) => Promise<void>;
    canDelete?: boolean;
    onOwnerOnlyAction?: (action: string) => void;
    onDelete: (doc: Document) => Promise<void> | void;
    documentRemovalMode?: "delete" | "detach";
    onOpenWorkflows?: (documents: Document[]) => void;
    onAssistantWorkflowSelect?: (selection: WorkflowSelection, documents: Document[]) => void;
}

const PLAIN_TEXT_VIEW_EXTENSIONS = new Set([
    "txt",
    "text",
    "md",
    "markdown",
    "mdown",
    "rst",
    "log",
]);

const ResearchMemoEditor = lazy(() => import("@/app/components/legal/ResearchMemoEditor"));
function ResearchFilePreview({ documentId }: { documentId: string }) {
    const [file, setFile] = useState<ResearchFile | null>();
    const [sourcePage, setSourcePage] = useState(0);
    useEffect(() => {
        let current = true;
        void getResearchFile(documentId).then(
            (value) => { if (current) setFile(value); },
            () => { if (current) setFile(null); },
        );
        return () => { current = false; };
    }, [documentId]);
    if (file === undefined) return <div role="status" className="grid h-full place-items-center text-sm text-gray-500">Loading research…</div>;
    if (!file) return <div role="alert" className="grid h-full place-items-center text-sm text-red-700">Could not load this research file.</div>;

    const { labels, sources, queries, note } = file.state;
    const savedSourceIds = Object.keys(sources), sourcePageIndex = Math.min(sourcePage,
        Math.max(0, Math.ceil(savedSourceIds.length / VERSION_PAGE) - 1)), sourceStart = sourcePageIndex * VERSION_PAGE,
        shownSources = savedSourceIds.slice(sourceStart, sourceStart + VERSION_PAGE).map((id) => sources[id]),
        passageCount = savedSourceIds.reduce((sum, id) => sum + (sources[id].passages?.count ?? 0), 0),
        searches = queries?.count ?? 0, allLabels = Object.values(labels), shownLabels = [...allLabels]
            .sort((left, right) => {
                if (left.scope !== right.scope) return left.scope.localeCompare(right.scope);
                const a = researchLabelPath(labels, left.id), b = researchLabelPath(labels, right.id);
                for (let index = 0; index < Math.max(a.length, b.length); index++) {
                    if (!a[index]) return -1;
                    if (!b[index]) return 1;
                    const order = a[index].order - b[index].order;
                    if (order) return order;
                }
                return left.name.localeCompare(right.name);
            }).slice(0, VERSION_PAGE * 2);

    return <div className="h-full overflow-auto rounded-lg bg-gray-50 px-4 py-4 text-sm">
        <p aria-label="Workspace contents" className="mb-5 text-sm text-gray-600">{savedSourceIds.length} {savedSourceIds.length === 1 ? "source" : "sources"} · {passageCount} {passageCount === 1 ? "highlight" : "highlights"} · {allLabels.length} {allLabels.length === 1 ? "label" : "labels"} · {searches} {searches === 1 ? "search" : "searches"}</p>
        {previewText(note).trim() && <section className="mb-6">
            <h2 className="mb-2 text-base font-semibold text-gray-950">Memo</h2>
            <Suspense fallback={<p className="whitespace-pre-wrap leading-6 text-gray-700">{previewText(note)}</p>}>
                <ResearchMemoEditor file={file} readOnly value={previewText(note)}
                    onOpenCitation={(href) => { window.open(href, "_blank", "noopener,noreferrer"); }} />
            </Suspense>
        </section>}
        <section className="mb-6">
            <h2 className="mb-2 text-base font-semibold text-gray-950">Labels</h2>
            {shownLabels.length ? <ul aria-label="Labels" className="grid gap-1 sm:grid-cols-2">
                {shownLabels.map((label) => {
                    const path = researchLabelPath(labels, label.id);
                    return <li key={label.id} className="flex min-h-9 items-center gap-2 rounded-md bg-white px-2.5 py-1.5"
                        style={{ paddingInlineStart: `${10 + (path.length - 1) * 14}px` }}>
                        <ResearchLabelCircle labels={labels} labelIds={[label.id]} size="sm" />
                        <span className="min-w-0 truncate font-medium text-gray-800">{label.name}</span>
                        <span className="ms-auto text-xs text-gray-500">{label.scope === "source" ? "Source" : "Highlight"}</span>
                    </li>;
                })}
            </ul> : <p className="text-sm text-gray-500">No labels yet</p>}
            {allLabels.length > shownLabels.length && <p className="mt-2 text-sm text-gray-500">{allLabels.length - shownLabels.length} more labels</p>}
        </section>
        <section>
            <h2 className="mb-2 text-base font-semibold text-gray-950">Sources</h2>
            {savedSourceIds.length ? <><ul aria-label="Saved sources" className="space-y-3">
                {shownSources.map((source) => {
                    const title = source.reference.title || source.reference.citation || source.reference.id,
                        sourcePassages = source.passages?.count ?? 0;
                    return <li key={source.id} className="rounded-lg border border-gray-200 bg-white p-3">
                        <article>
                            <header className="flex items-start gap-2">
                                <ResearchLabelCircle labels={labels} labelIds={source.labelIds} size="sm" />
                                <div className="min-w-0 flex-1">
                                    <h3 className="break-words font-semibold leading-5 text-gray-900">{title}</h3>
                                    {source.reference.citation && source.reference.citation !== title && <p className="text-[13px] text-gray-500">{source.reference.citation}</p>}
                                </div>
                                <span className="shrink-0 text-sm tabular-nums text-gray-500">{sourcePassages} {sourcePassages === 1 ? "highlight" : "highlights"}</span>
                            </header>
                            {previewText(source.note).trim() && <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-gray-700">{previewText(source.note)}</p>}
                        </article>
                    </li>;
                })}
            </ul>{savedSourceIds.length > VERSION_PAGE && <div className="mt-3 flex items-center justify-between text-xs">
                <button type="button" disabled={!sourcePageIndex} onClick={() => setSourcePage(sourcePageIndex - 1)}>Previous sources</button>
                <span>{sourceStart + 1}-{sourceStart + shownSources.length} of {savedSourceIds.length}</span>
                <button type="button" disabled={sourceStart + VERSION_PAGE >= savedSourceIds.length}
                    onClick={() => setSourcePage(sourcePageIndex + 1)}>Next sources</button>
            </div>}</> : <p className="text-[13px] text-gray-500">No saved sources yet</p>}
        </section>
    </div>;
}

export function DocumentSidePanel({
    doc,
    versionId,
    currentVersionId,
    versions,
    versionsLoading,
    versionsError = false,
    onClose,
    onLoadVersions,
    onSelectVersion,
    onDownloadVersion,
    onRenameDocument,
    onCheckpointVersion,
    onRestoreVersion,
    onCompareVersions,
    onUploadNewVersion,
    canDelete = true,
    onOwnerOnlyAction,
    onDelete,
    documentRemovalMode = "delete",
    onOpenWorkflows,
    onAssistantWorkflowSelect,
}: Props) {
    const [visibleVersionCount, setVisibleVersionCount] =
        useState(VERSION_PAGE);
    const [editingName, setEditingName] = useState(false);
    const [expandedReader, setExpandedReader] = useState(false);
    const [narrowDetailsOpen, setNarrowDetailsOpen] = useState(false);
    const readerBody = useRef<HTMLDivElement>(null);
    const restoreReaderScroll = useRef<(() => void) | null>(null);
    function changeReaderSize(next: boolean) {
        if (next) restoreReaderScroll.current = preserveReaderScroll(readerBody.current);
        setExpandedReader(next);
    }
    useLayoutEffect(() => {
        if (!expandedReader) { restoreReaderScroll.current?.(); restoreReaderScroll.current = null; }
    }, [expandedReader]);
    const [nameDraft, setNameDraft] = useState("");
    const [savingName, setSavingName] = useState(false);
    const [extensionWarningOpen, setExtensionWarningOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [checkpointing, setCheckpointing] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [restoreTarget, setRestoreTarget] = useState<DocumentVersion | null>(null);
    const [restoringId, setRestoringId] = useState<string | null>(null);
    const [comparingId, setComparingId] = useState<string | null>(null);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteStatus, setDeleteStatus] = useState<
        "idle" | "deleting" | "deleted"
    >("idle");
    const uploadRef = useRef<HTMLInputElement>(null);
    const deleteTarget = useRef<Document | null>(null);
    const sourcesController = useSourcesWorkspaceOrNull();
    const highlightController = sourcesController?.highlight ?? null;
    const captureReference: ResearchSourceReference | null =
        doc && (versionId ?? doc.current_version_id)
            ? { provider: "library", kind: "document", id: doc.id,
                versionId: (versionId ?? doc.current_version_id) as string,
                title: doc.filename }
            : null;
    useLibraryReaderCapture(readerBody, captureReference, highlightController);
    const [savedQuotes, setSavedQuotes] = useState<CitationQuote[]>([]);
    const ontologyFile = sourcesController?.file ?? null;
    const captureKey = captureReference ? researchSourceKey(captureReference) : null;
    useEffect(() => {
        if (!ontologyFile || !captureKey) { setSavedQuotes([]); return; }
        const source = Object.values(ontologyFile.state.sources).find(({ reference }) =>
            researchSourceKey(reference) === captureKey);
        if (!source) { setSavedQuotes([]); return; }
        let cancelled = false;
        void getResearchItems(ontologyFile.document.id, { kind: "passages", sourceId: source.id }).then((page) => {
            if (cancelled) return;
            setSavedQuotes(page.items.flatMap((item) => item.kind === "passage" && item.value.receipt.span_text
                ? [{ quote: item.value.receipt.span_text }] : []));
        }).catch(() => { if (!cancelled) setSavedQuotes([]); });
        return () => { cancelled = true; };
    }, [ontologyFile, captureKey]);
    const loadVersions = useEffectEvent(onLoadVersions);
    const docId = doc?.id;

    useEffect(() => {
        if (!docId) return;
        void loadVersions(docId);
    }, [docId]);

    useEffect(() => {
        setVisibleVersionCount(VERSION_PAGE);
        setActionError(null);
        deleteTarget.current = null;
        setDeleteOpen(false);
    }, [doc?.id]);

    useEffect(() => {
        setEditingName(false);
        setNameDraft("");
    }, [docId]);

    useEffect(() => {
        setRestoreTarget(null);
    }, [versionId, currentVersionId]);

    if (!doc) return null;

    const activeDoc = doc;
    const currentId =
        currentVersionId ?? activeDoc.current_version_id ?? null;
    const ordered = versions;
    const current = versions.find(({ id }) => id === currentId) ?? null;
    const comparisonCurrent = current && fileType(current, "") === "docx" ? current : null;
    const priorCurrent = comparisonCurrent
        ? ordered.find(({ version_number }) =>
            version_number < comparisonCurrent.version_number) ?? null
        : null;
    const visible = ordered.slice(0, visibleVersionCount);
    const selected =
        versions.find((version) => version.id === versionId) ??
        current ??
        ordered[0] ??
        null;
    const selectedId = selected?.id ?? versionId ?? currentId;
    const filename = selected?.filename.trim() || activeDoc.filename;
    const displayFilename = activeDoc.filename.replace(/\.research\.md$/iu, "");
    const type = fileType(selected, activeDoc.file_type);
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    const isDocx =
        isDocxFilename(filename) || type === "docx" || type === "doc";
    const isSpreadsheet =
        isSpreadsheetFilename(filename) ||
        ["xlsx", "xlsm", "xls"].includes(type);
    const revision = selectedId && selectedId === currentId
        ? `${selectedId}:${selected?.working_revision ?? activeDoc.current_working_revision ?? 0}`
        : selected ? `${selected.id}:${selected.working_revision}` : activeDoc.updated_at;
    const canCheckpoint = (current?.working_revision ?? activeDoc.current_working_revision ?? 0) > 0;
    const selectedComparison = selected ? comparison(selected) : null;
    const activeVersionCount = versions.length;
    const showResearchPreview =
        isResearchDocument(activeDoc) && selectedId === currentId;
    const previewable = showResearchPreview || isDocx || isSpreadsheet || type === "pdf" ||
        PLAIN_TEXT_VIEW_EXTENSIONS.has(extension) || PLAIN_TEXT_VIEW_EXTENSIONS.has(type);

    async function saveName() {
        const entered = nameDraft.trim();
        if (!entered) return;
        const next = isResearchDocument(activeDoc)
            ? `${entered.replace(/\.research\.md$/iu, "")}.research.md` : entered;
        if (hasFilenameExtensionChange(activeDoc.filename, next)) {
            return setExtensionWarningOpen(true);
        }
        if (next === activeDoc.filename) return setEditingName(false);
        setSavingName(true);
        setActionError(null);
        try {
            await onRenameDocument(activeDoc.id, next);
            setEditingName(false);
        } catch {
            setActionError("Could not rename this document.");
        } finally {
            setSavingName(false);
        }
    }

    async function upload(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setUploading(true);
        setActionError(null);
        try {
            await onUploadNewVersion(activeDoc, file);
        } catch {
            setActionError("Could not upload the new version.");
        } finally {
            setUploading(false);
        }
    }

    async function checkpoint(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!canCheckpoint || checkpointing) return;
        const form = event.currentTarget;
        const comment = String(new FormData(form).get("comment") ?? "").trim();
        setCheckpointing(true);
        setActionError(null);
        try {
            await onCheckpointVersion(activeDoc.id, comment || undefined);
            form.reset();
        } catch {
            setActionError("Could not create this version.");
        } finally {
            setCheckpointing(false);
        }
    }

    async function restoreVersion() {
        if (!restoreTarget) return;
        setRestoringId(restoreTarget.id);
        setActionError(null);
        try {
            await onRestoreVersion(activeDoc.id, restoreTarget.id);
            setRestoreTarget(null);
        } catch {
            setRestoreTarget(null);
            setActionError(
                "Could not restore this version. Review the latest history and try again.",
            );
        } finally {
            setRestoringId(null);
        }
    }

    async function compareVersions(rowId: string, baselineId: string, comparedId: string) {
        setComparingId(rowId);
        setActionError(null);
        try {
            await onCompareVersions(activeDoc.id, baselineId, comparedId);
        } catch {
            setActionError("Could not create the comparison.");
        } finally {
            setComparingId(null);
        }
    }

    async function downloadVersion(version: DocumentVersion) {
        setActionError(null);
        try {
            await onDownloadVersion(
                activeDoc.id,
                version.id,
                versionFilename(version),
            );
        } catch {
            setActionError("Could not download this version.");
        }
    }

    function comparison(version: DocumentVersion) {
        if (!comparisonCurrent) return null;
        const baseline = version.id === currentId
            ? priorCurrent
            : version;
        if (!baseline || fileType(baseline, "") !== "docx") return null;
        return {
            baselineId: baseline.id,
            comparedId: comparisonCurrent.id,
            label: `Download comparison: ${version.id === currentId ? "prior " : ""}${versionTitle(baseline)} to current ${versionTitle(comparisonCurrent)}`,
        };
    }

    async function removeDocument() {
        if (deleteStatus === "deleting") return;
        setDeleteStatus("deleting");
        setActionError(null);
        try {
            await onDelete(deleteTarget.current ?? activeDoc);
            setDeleteStatus("deleted");
            window.setTimeout(() => {
                setDeleteOpen(false);
                setDeleteStatus("idle");
                onClose();
            }, 650);
        } catch {
            setDeleteOpen(false);
            setDeleteStatus("idle");
            setActionError(
                documentRemovalMode === "detach"
                    ? "The document could not be removed from this project. Please try again."
                    : "The document could not be deleted. Please try again.",
            );
        }
    }

    function requestDelete() {
        if (!canDelete) {
            return onOwnerOnlyAction?.(
                documentRemovalMode === "detach"
                    ? "remove this document from the project"
                    : "delete this document",
            );
        }
        setDeleteStatus("idle");
        deleteTarget.current = activeDoc;
        setDeleteOpen(true);
    }

    const deleteMessage =
        documentRemovalMode === "detach"
            ? `Remove ${displayFilename} from this project? The Library file and its links in other projects will be kept.`
            : activeVersionCount > 0
              ? `${displayFilename} has ${activeVersionCount} ${
                    activeVersionCount === 1 ? "version" : "versions"
                }. Deleting this document will delete all of its versions.`
              : `Delete ${displayFilename}? This will delete the document and all of its versions.`;

    return (
        <Modal
            open
            onClose={onClose}
            onEscape={() => expandedReader ? changeReaderSize(false) : onClose()}
            size="2xl"
            className={expandedReader
                ? "!h-[100dvh] !w-[100vw] !max-h-none !max-w-none !m-0 !rounded-none"
                : "!max-w-[960px]"}
            breadcrumbs={[
                <span key="document" className="flex h-8 min-w-0 items-center gap-2 text-sm font-medium leading-5 text-gray-900">
                <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gray-600">{activeDoc.file_type || type || "File"}</span>{" "}
                <span className="relative block min-w-0 flex-1">
                    <span className={`block truncate ${editingName ? "invisible" : ""}`}>{displayFilename}</span>
                {editingName && (
                    <input
                        autoFocus
                        value={nameDraft}
                        onChange={(event) => setNameDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void saveName();
                            if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                setEditingName(false);
                            }
                        }}
                        className="absolute inset-0 h-full w-full min-w-0 rounded-none border-0 bg-transparent p-0 text-sm font-medium leading-5 text-gray-900 outline-none focus-visible:ring-1 focus-visible:ring-gray-400"
                        aria-label="Document name"
                    />
                )}
                </span>
                </span>,
            ]}
            headerAction={
                <div className="flex shrink-0 items-center gap-1.5">
                <ReaderExpandButton expanded={expandedReader} onChange={changeReaderSize} />
                {highlightController && (
                    <button
                        type="button"
                        aria-label="Highlight"
                        aria-pressed={highlightController.armed}
                        title="Highlight"
                        onClick={() => {
                            setActionError(null);
                            void highlightController.run().catch((reason: unknown) => {
                                setActionError(reason instanceof Error ? reason.message
                                    : "Could not save this highlight");
                            });
                        }}
                        className="h-8 w-8 rounded hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                    >
                        <Highlighter className="mx-auto h-4 w-4" />
                    </button>
                )}
                {editingName ? (
                    <button
                        type="button"
                        onClick={() => void saveName()}
                        disabled={savingName}
                        aria-label="Save document name"
                        title="Save document name"
                        className="h-8 w-8 rounded hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                    >
                        {savingName ? (
                            <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                        ) : (
                            <Check className="mx-auto h-4 w-4" />
                        )}
                    </button>
                ) : (
                    <button
                        type="button"
                        aria-label="Rename document"
                        title="Rename document"
                        onClick={() => {
                            setNameDraft(displayFilename);
                            setEditingName(true);
                        }}
                        className="h-8 w-8 rounded hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                    >
                        <Pencil className="mx-auto h-4 w-4" />
                    </button>
                )}
                <ContextualWorkflowLauncher
                    documents={[activeDoc]}
                    onOpen={onOpenWorkflows ? () => {
                        onOpenWorkflows([activeDoc]);
                        onClose();
                    } : undefined}
                    onAssistantSelect={onAssistantWorkflowSelect
                        ? (selection) => onAssistantWorkflowSelect(selection, [activeDoc])
                        : undefined}
                />
                {showResearchPreview && (
                    <a
                        href={`/sources?research_file=${encodeURIComponent(activeDoc.id)}`}
                        className="inline-flex h-8 shrink-0 items-center rounded border border-gray-900 bg-gray-900 px-3 text-xs font-medium text-white hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2"
                    >
                        Open in Sources
                    </a>
                )}
                </div>
            }
        >
            <div ref={readerBody} data-highlighter={highlightController?.armed || undefined}
                className={`@container -mx-5 flex min-h-0 flex-1 flex-col overflow-hidden ${highlightController?.armed ? "cursor-crosshair" : ""}`}>
            <main className="flex min-h-0 flex-1 flex-col @min-[42rem]:grid @min-[42rem]:grid-cols-[minmax(0,1fr)_22rem]">
                <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3">
                    {showResearchPreview ? <ResearchFilePreview
                        key={`${activeDoc.id}:${revision ?? ""}`} documentId={activeDoc.id} /> : previewable ? <DocumentViewer
                        key={`${activeDoc.id}:${
                            selectedId ?? "current"
                        }:${revision ?? ""}`}
                        documentId={activeDoc.id}
                        kind={
                            isSpreadsheet
                                ? "spreadsheet"
                                : PLAIN_TEXT_VIEW_EXTENSIONS.has(extension) ||
                                    PLAIN_TEXT_VIEW_EXTENSIONS.has(type)
                                  ? "text"
                                  : isDocx
                                    ? "docx"
                                    : "pdf"
                        }
                        {...(savedQuotes.length && (isDocx || (!isSpreadsheet && type === "pdf")) ? { quotes: savedQuotes } : {})}
                        filename={filename}
                        versionId={selectedId}
                        preferPdfRendition={isDocx}
                        refetchKey={revision ?? undefined}
                        revision={revision}
                    /> : <p className="m-auto text-sm text-gray-500">Preview is not available for this file type.</p>}
                </section>
                <aside className="flex max-h-[45%] min-h-0 min-w-0 shrink-0 flex-col border-t border-gray-200 @min-[42rem]:max-h-none @min-[42rem]:border-l @min-[42rem]:border-t-0">
                    <div className="flex min-h-8 shrink-0 items-center gap-2 px-3 py-2">
                    <button type="button" aria-expanded={narrowDetailsOpen} aria-controls="document-details"
                        onClick={() => setNarrowDetailsOpen((open) => !open)}
                        className="flex min-h-9 shrink-0 items-center gap-2 text-xs font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 @min-[42rem]:hidden">
                        Details <ChevronDown aria-hidden className={`size-3.5 ${narrowDetailsOpen ? "rotate-180" : ""}`} />
                    </button>
                        <h2 className="hidden text-xs font-medium text-gray-700 @min-[42rem]:block">Details</h2>
                        <div className="ml-auto flex items-center gap-1">
                            <Button variant="ghost" size="icon-sm" disabled={!selected}
                                aria-label={`Download ${versionTitle(selected)}`} title="Download selected version"
                                onClick={() => { if (selected) void downloadVersion(selected); }}>
                                <Download aria-hidden />
                            </Button>
                            <Button variant="ghost" size="icon-sm"
                                disabled={!selected || selectedId === currentId || !!restoringId}
                                aria-label={`Restore ${versionTitle(selected)} as a new current version`} title="Restore selected version"
                                onClick={() => setRestoreTarget(selected)}>
                                {restoringId ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCcw aria-hidden />}
                            </Button>
                            {comparisonCurrent && <Button variant="ghost" size="icon-sm"
                                disabled={!selectedComparison || !!comparingId || !!restoringId}
                                aria-label={selectedComparison?.label ?? "Download comparison"} title="Download comparison with current version"
                                onClick={() => { if (selected && selectedComparison) void compareVersions(selected.id,
                                    selectedComparison.baselineId, selectedComparison.comparedId); }}>
                                {comparingId ? <Loader2 aria-hidden className="animate-spin" /> : <FileDiff aria-hidden />}
                            </Button>}
                        </div>
                    </div>
                    <div id="document-details" className={`${narrowDetailsOpen ? "flex" : "hidden"} min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3 @min-[42rem]:flex`}>
                    <div className="min-w-0 flex-1 pb-2">
                    <table aria-label="Document versions" className="w-full text-left text-xs">
                        <thead className="sticky top-0 bg-white text-gray-500"><tr>
                            {['Version', 'Date', 'By', 'Size', 'Pages'].map((label) => <th key={label} scope="col" className="border-b border-gray-200 px-1 py-1 font-medium last:text-right">{label}</th>)}
                        </tr></thead>
                        <tbody>
                        {versionsLoading && !versions.length ? (
                            <tr><td colSpan={5}><VersionLoading /></td></tr>
                        ) : versionsError ? (
                            <tr><td colSpan={5} role="alert" className="py-3 text-xs text-red-700">
                                Could not load version history. <button type="button"
                                    onClick={() => void onLoadVersions(activeDoc.id, true)}
                                    className="font-semibold underline">Retry</button>
                            </td></tr>
                        ) : !ordered.length ? (
                            <tr><td colSpan={5} className="py-3 text-xs text-gray-500">
                                No version history.
                            </td></tr>
                        ) : (
                            <>
                                {visible.map((version) => (
                                    <VersionRow
                                        key={version.id}
                                        version={version}
                                        selected={version.id === selectedId}
                                        current={version.id === currentId}
                                        onSelect={() => {
                                            setActionError(null);
                                            onSelectVersion(version.id);
                                        }}
                                    />
                                ))}
                                {visible.length < ordered.length && (
                                    <tr><td colSpan={5}>
                                        <button
                                            type="button"
                                            className="w-full border-t border-gray-200 py-2 text-xs font-medium hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900"
                                            onClick={() =>
                                                setVisibleVersionCount(
                                                    (count) =>
                                                        count + VERSION_PAGE,
                                                )
                                            }
                                        >
                                            Show more
                                        </button>
                                    </td></tr>
                                )}
                            </>
                        )}
                        </tbody>
                    </table>
                    </div>
                    {canCheckpoint && <form aria-label="Save version" onSubmit={checkpoint}
                        className="flex shrink-0 gap-2 pt-2">
                        <label htmlFor="version-comment" className="sr-only">Version comment (optional)</label>
                        <input id="version-comment" name="comment" maxLength={1000}
                            placeholder="Comment (optional)"
                            className="h-8 min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 text-sm outline-none focus:ring-2 focus:ring-gray-900"
                        />
                        <Button variant="outline" size="compact" type="submit"
                            disabled={checkpointing || versionsLoading || !current}>
                            {checkpointing ? <Loader2 aria-hidden className="animate-spin" />
                                : <Save aria-hidden />}
                            Save version
                        </Button>
                    </form>}
                    {actionError && (
                        <p role="alert" className="flex items-center gap-2 py-2 text-xs text-red-700">
                            <AlertCircle aria-hidden className="h-3.5 w-3.5 shrink-0" />
                            {actionError}
                        </p>
                    )}
                    <div className="flex shrink-0 justify-between gap-2 pt-3">
                        <Button
                            variant="danger"
                            size="compact"
                            onClick={requestDelete}
                            disabled={deleteStatus === "deleting"}
                        >
                            {deleteStatus === "deleting" ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                            )}
                            {documentRemovalMode === "detach"
                                ? "Remove"
                                : "Delete"}
                        </Button>
                        <Button size="compact" onClick={() => uploadRef.current?.click()}
                            disabled={uploading}>
                            {uploading ? <Loader2 aria-hidden className="animate-spin" />
                                : <Upload aria-hidden />}
                            Upload new version
                        </Button>
                    </div>
                    </div>
                </aside>
            </main>
            <input
                ref={uploadRef}
                type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT}
                className="hidden"
                onChange={upload}
            />
            <WarningPopup
                open={extensionWarningOpen}
                onClose={() => setExtensionWarningOpen(false)}
                message={filenameExtensionChangeWarning(activeDoc.filename)}
            />
            <ConfirmPopup
                open={!!restoreTarget}
                title="Restore this version?"
                message={`${versionTitle(restoreTarget)} will become a new current version. Existing history will be kept.`}
                confirmLabel="Restore"
                confirmStatus={restoringId ? "loading" : "idle"}
                cancelLabel="Cancel"
                onCancel={() => { if (!restoringId) setRestoreTarget(null); }}
                onConfirm={() => void restoreVersion()}
            />
            <ConfirmPopup
                open={deleteOpen}
                title={
                    documentRemovalMode === "detach"
                        ? "Remove from project?"
                        : "Delete document?"
                }
                message={deleteMessage}
                confirmLabel={
                    documentRemovalMode === "detach" ? "Remove" : "Delete"
                }
                confirmStatus={
                    deleteStatus === "deleting"
                        ? "loading"
                        : deleteStatus === "deleted"
                          ? "complete"
                          : "idle"
                }
                cancelLabel="Cancel"
                onCancel={() => {
                    if (deleteStatus !== "deleting") {
                        deleteTarget.current = null;
                        setDeleteOpen(false);
                        setDeleteStatus("idle");
                    }
                }}
                onConfirm={() => void removeDocument()}
            />
            </div>
        </Modal>
    );
}

function VersionLoading() {
    return (
        <div className="space-y-1 p-2">
            {[1, 2, 3].map((id) => (
                <div
                    key={id}
                    className="h-12 animate-pulse rounded bg-gray-100"
                />
            ))}
        </div>
    );
}

function VersionRow({ version, selected, current, onSelect }: {
    version: DocumentVersion;
    selected: boolean;
    current: boolean;
    onSelect: () => void;
}) {
    const title = versionTitle(version), name = versionFilename(version);
    const provenance = version.provenance?.actor === "assistant"
        ? `Beaver edit${version.provenance.change_count ? ` · ${version.provenance.change_count} changes` : ""}` : "";
    const actor = version.author_email || (version.provenance?.actor === "assistant" ? "Beaver" : "—");
    return <>
        <tr onClick={onSelect} className={`cursor-pointer border-b border-gray-200 align-top hover:bg-gray-50 ${selected ? "bg-gray-100" : ""}`}>
            <td className="px-1 py-1"><button type="button" aria-current={selected ? "true" : undefined}
                aria-label={`${canPreviewVersion(version) ? "Preview" : "Select"} ${title}: ${name}${current ? ", Current" : ""}`} title={[name, provenance].filter(Boolean).join(" — ")}
                className="inline-flex flex-wrap items-center gap-1 text-left font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-gray-900">
                v{version.version_number}
                {current && <Check aria-hidden className="size-3.5 shrink-0" />}
            </button></td>
            <td className="px-1 py-1 text-gray-600"><time dateTime={version.created_at} title={formatDate(version.created_at)}>
                {new Date(version.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
            </time></td>
            <td className="max-w-24 break-words px-1 py-1 text-gray-600 [overflow-wrap:anywhere]" title={actor}>{actor}</td>
            <td className="px-1 py-1 tabular-nums text-gray-600">{formatBytes(version.size_bytes) ?? "—"}</td>
            <td className="px-1 py-1 text-right tabular-nums text-gray-600">{version.page_count ?? "—"}</td>
        </tr>
        {version.comment?.trim() && <tr className={selected ? "bg-gray-100" : ""}><td colSpan={5}
            className="whitespace-pre-wrap break-words px-1 pb-2 text-gray-600 [overflow-wrap:anywhere]">{version.comment}</td></tr>}
    </>;
}

function versionTitle(version: DocumentVersion | null) {
    return version ? `Version ${version.version_number}` : "Version";
}

function versionFilename(version: DocumentVersion) {
    return version.filename.trim() || (version.source === "upload" ? "Original" : "—");
}

function canPreviewVersion(version: DocumentVersion) {
    const name = versionFilename(version), type = fileType(version, "");
    const extension = name.split(".").pop()?.toLowerCase() ?? "";
    return type === "pdf" || type === "doc" || type === "docx" ||
        isSpreadsheetFilename(name) || PLAIN_TEXT_VIEW_EXTENSIONS.has(type) ||
        PLAIN_TEXT_VIEW_EXTENSIONS.has(extension);
}

function fileType(
    version: DocumentVersion | null,
    fallback: string | null | undefined,
) {
    return version?.file_type.toLowerCase() || fallback?.toLowerCase() || "";
}

function formatDate(iso: string | null | undefined) {
    return iso
        ? new Date(iso).toLocaleString(undefined, {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
          })
        : "—";
}

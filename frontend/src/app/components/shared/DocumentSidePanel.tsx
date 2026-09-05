import {
    useEffect,
    useEffectEvent,
    useRef,
    useState,
    type ChangeEvent,
    type FormEvent,
} from "react";
import {
    AlertCircle,
    Check,
    Download,
    Eye,
    FileDiff,
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
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { Button } from "@/app/components/ui/button";
import type { Document } from "@/app/components/shared/types";
import {
    isDocxFilename,
    isSpreadsheetFilename,
} from "@/app/components/shared/types";
import { DocumentViewer } from "@/app/components/shared/views/DocumentViewer";
import type { DocumentVersion } from "@/app/lib/beaverApi";
import { formatBytes } from "@/app/lib/utils";
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";
import {
    filenameExtensionChangeWarning,
    hasFilenameExtensionChange,
} from "@/app/lib/documentFilename";
import { getResearchFile } from "@/app/lib/beaverApi";
import { ResearchLabelCircle } from "@/app/components/legal/ResearchLabelCircle";
import {
    isResearchDocument,
    researchLabelPath,
    type ResearchFile,
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
            <h2 className="mb-2 text-base font-semibold text-gray-950">Note</h2>
            <p className="whitespace-pre-wrap leading-6 text-gray-700">{previewText(note)}</p>
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
    const displayFilename = filename.replace(/\.research\.md$/iu, "");
    const type = fileType(selected, activeDoc.file_type);
    const size = selected?.size_bytes ?? activeDoc.size_bytes;
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    const isDocx =
        isDocxFilename(filename) || type === "docx" || type === "doc";
    const isSpreadsheet =
        isSpreadsheetFilename(filename) ||
        ["xlsx", "xlsm", "xls"].includes(type);
    const revision = selectedId && selectedId === currentId
        ? `${selectedId}:${selected?.working_revision ?? activeDoc.current_working_revision ?? 0}`
        : selected ? `${selected.id}:${selected.working_revision}` : activeDoc.updated_at;
    const pages = selected?.page_count ??
        (selectedId === currentId ? activeDoc.page_count : null);
    const activeVersionCount = versions.length;
    const showResearchPreview =
        isResearchDocument(activeDoc) && selectedId === currentId;
    const previewable = showResearchPreview || isDocx || isSpreadsheet || type === "pdf" ||
        PLAIN_TEXT_VIEW_EXTENSIONS.has(extension) || PLAIN_TEXT_VIEW_EXTENSIONS.has(type);

    async function saveName() {
        if (!selectedId || selectedId !== currentId) return;
        const entered = nameDraft.trim();
        if (!entered) return;
        const next = isResearchDocument(activeDoc)
            ? `${entered.replace(/\.research\.md$/iu, "")}.research.md` : entered;
        if (hasFilenameExtensionChange(filename, next)) {
            return setExtensionWarningOpen(true);
        }
        if (next === filename) return setEditingName(false);
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
            size="2xl"
            className="!h-[calc(100dvh-1.5rem)] !max-w-[960px]"
            breadcrumbs={[
                <span key="document" className="flex h-8 min-w-0 items-center gap-2 text-sm font-medium leading-5 text-gray-900">
                <FileTypeIcon
                    fileType={type || filename}
                    filename={filename}
                    className="h-4 w-4 shrink-0"
                />
                {editingName ? (
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
                        className="h-8 min-w-0 max-w-80 border-0 border-b border-gray-400 bg-transparent p-0 text-sm font-medium leading-5 text-gray-900 outline-none [field-sizing:content] focus-visible:border-gray-900"
                        aria-label="Document name"
                    />
                ) : (
                    <span className="min-w-0 truncate">
                        {displayFilename}
                    </span>
                )}
                </span>,
            ]}
            headerAction={
                <div className="flex shrink-0 items-center gap-1.5">
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
                ) : selectedId === currentId ? (
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
                ) : null}
                <ContextualWorkflowLauncher
                    documents={[activeDoc]}
                    onOpen={onOpenWorkflows ? () => {
                        onOpenWorkflows([activeDoc]);
                        onClose();
                    } : undefined}
                    onAssistantSelect={onAssistantWorkflowSelect
                        ? (selection) => onAssistantWorkflowSelect(selection, [activeDoc])
                        : undefined}
                    onDocumentChanged={async (result) => {
                        await onLoadVersions(activeDoc.id, true);
                        onSelectVersion(result.version_id);
                    }}
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
            <div className="-mx-5 flex min-h-0 flex-1 flex-col overflow-hidden">
            <main className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_20rem]">
                <section className="flex min-h-0 min-w-0 flex-col overflow-hidden p-3">
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
                        filename={filename}
                        versionId={selectedId}
                        preferPdfRendition={isDocx}
                        refetchKey={revision ?? undefined}
                        revision={revision}
                    /> : <p className="m-auto text-sm text-gray-500">Preview is not available for this file type.</p>}
                </section>
                <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-t border-gray-200 p-4 md:border-l md:border-t-0">
                    <div className="mb-3 grid gap-1 text-xs">
                        <Info label="Type" value={type || "—"} />
                        <Info label="Size" value={formatBytes(size) ?? "—"} />
                        <Info
                            label="Created"
                            value={formatDate(
                                selected?.created_at ?? activeDoc.created_at,
                            )}
                        />
                        {pages != null && (
                            <Info
                                label="Pages"
                                value={String(pages)}
                            />
                        )}
                    </div>
                    <div className="mb-2 flex min-h-8 items-center gap-2">
                        <h2 className="text-sm font-semibold">
                            Versions{" "}
                            <span className="font-normal text-gray-500">
                                {versions.length}
                            </span>
                        </h2>
                    </div>
                    <ul
                        aria-label="Document versions"
                        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden rounded border border-gray-300"
                    >
                        {versionsLoading && !versions.length ? (
                            <li><VersionLoading /></li>
                        ) : versionsError ? (
                            <li role="alert" className="p-3 text-xs text-red-700">
                                Could not load version history. <button type="button"
                                    onClick={() => void onLoadVersions(activeDoc.id, true)}
                                    className="font-semibold underline">Retry</button>
                            </li>
                        ) : !ordered.length ? (
                            <li className="p-3 text-xs text-gray-500">
                                No version history.
                            </li>
                        ) : (
                            <>
                                {visible.map((version) => (
                                    <VersionRow
                                        key={version.id}
                                        version={version}
                                        selected={version.id === selectedId}
                                        current={version.id === currentId}
                                        restoring={restoringId === version.id}
                                        comparing={comparingId === version.id}
                                        onSelect={canPreviewVersion(version) ? () => {
                                            setActionError(null);
                                            onSelectVersion(version.id);
                                        } : undefined}
                                        onDownload={() => void downloadVersion(version)}
                                        onRestore={version.id === currentId ? undefined
                                            : () => setRestoreTarget(version)}
                                        comparison={comparison(version)}
                                        onCompare={(baselineId, comparedId) =>
                                            void compareVersions(version.id,
                                                baselineId, comparedId)}
                                    />
                                ))}
                                {visible.length < ordered.length && (
                                    <li>
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
                                    </li>
                                )}
                            </>
                        )}
                    </ul>
                    <form aria-label="Save version" onSubmit={checkpoint}
                        className="grid shrink-0 gap-2 pt-2">
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
                    </form>
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
                message={filenameExtensionChangeWarning(filename)}
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

function Info({ label, value }: { label: string; value: string }) {
    return (
        <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
            <span className="text-gray-500">{label}</span>
            <span className="truncate text-gray-800">{value}</span>
        </div>
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

function VersionRow({
    version,
    selected,
    current,
    restoring,
    comparing,
    onSelect,
    onDownload,
    onRestore,
    comparison,
    onCompare,
}: {
    version: DocumentVersion;
    selected: boolean;
    current: boolean;
    restoring: boolean;
    comparing: boolean;
    onSelect?: () => void;
    onDownload: () => void;
    onRestore?: () => void;
    comparison: {
        baselineId: string;
        comparedId: string;
        label: string;
    } | null;
    onCompare: (baselineId: string, comparedId: string) => void;
}) {
    const title = versionTitle(version);
    const name = versionFilename(version);
    const downloadLabel = `Download ${title}`;
    const restoreLabel = `Restore ${title} as a new current version`;
    const actor = version.author_email || (version.created_by ? "You" : "");
    const summary = <>
        <span className="flex min-w-0 items-center gap-1.5">
            <FileTypeIcon fileType={name} className="h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
            <span className="flex shrink-0 items-center gap-1 text-xs text-gray-500">
                {selected && <Eye aria-hidden className="h-3 w-3" />}{title}
            </span>
        </span>
        <span className="block min-w-0 truncate text-xs text-gray-500">
            {formatDate(version.created_at)} · {versionOrigin(version)}
            {actor ? ` · ${actor}` : ""}
            {current ? " · Current" : ""}{!onSelect ? " · Preview unavailable" : ""}
        </span>
        {version.comment?.trim() && <span className="mt-0.5 block line-clamp-2 text-xs text-gray-700">
            {version.comment}
        </span>}
    </>;

    return (
        <li
            className={`group grid min-h-14 grid-cols-[minmax(0,1fr)_auto] border-b border-gray-200 ${
                selected
                    ? "border-l-2 border-l-gray-950 bg-gray-100"
                    : "border-l-2 border-l-transparent"
            }`}
        >
            {onSelect ? <button type="button" aria-current={selected ? "true" : undefined}
                aria-label={`Preview ${title}: ${name}`} onClick={onSelect}
                className="min-w-0 px-3 py-2 text-left outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900">
                {summary}
            </button> : <div className="min-w-0 px-3 py-2 text-left">{summary}</div>}
            <div className="flex h-full items-end pb-1 pr-1">
                        {comparison && <button
                            type="button"
                            aria-label={comparison.label}
                            title={comparison.label}
                            disabled={comparing || restoring}
                            onClick={() => onCompare(
                                comparison.baselineId,
                                comparison.comparedId,
                            )}
                            className="h-8 w-8 rounded hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                        >
                            {comparing ? <Loader2 aria-hidden className="mx-auto h-3.5 w-3.5 animate-spin" />
                                : <FileDiff aria-hidden className="mx-auto h-3.5 w-3.5" />}
                        </button>}
                        <button
                            type="button"
                            aria-label={downloadLabel}
                            title={downloadLabel}
                            onClick={onDownload}
                            className="h-8 w-8 rounded hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                        >
                            <Download aria-hidden className="mx-auto h-3.5 w-3.5" />
                        </button>
                        {onRestore && <button
                            type="button"
                            aria-label={restoreLabel}
                            title={restoreLabel}
                            disabled={restoring || comparing}
                            onClick={onRestore}
                            className="h-8 w-8 rounded hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 disabled:opacity-40"
                        >
                            {restoring ? (
                                <Loader2 aria-hidden className="mx-auto h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <RotateCcw aria-hidden className="mx-auto h-3.5 w-3.5" />
                            )}
                        </button>}
            </div>
        </li>
    );
}

function versionOrigin(version: DocumentVersion) {
    if (version.source === "restore") return "Restored";
    if (version.source === "snapshot") return "Created";
    if (version.provenance?.actor === "assistant") {
        const changes = version.provenance.change_count;
        return changes
            ? `Beaver edit · ${changes} ${changes === 1 ? "change" : "changes"}`
            : "Beaver edit";
    }
    if (version.provenance?.actor === "work-product") {
        const kind = version.provenance.receipt?.workProduct?.kind;
        return kind === "authorities" ? "Authorities build"
            : kind === "court-record" ? "Court record build" : "Generated build";
    }
    return version.source === "generated" ? "Generated" : "Uploaded";
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

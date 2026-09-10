import { type Dispatch, type DragEvent, type ReactNode, type SetStateAction,
    useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { AlertCircle, TriangleAlert, ChevronDown, ChevronRight, Eye, Loader2 }
    from "lucide-react";
import {
  deleteDocument,
  downloadDocumentsZip,
  downloadDocument,
  listDirectoryDocuments,
  type Document,
  type Folder as ProjectFolder,
  type LibraryFolder,
} from "@/app/lib/api/documents";
import { downloadBlob } from "@/app/lib/download";

import { InlineNameInput } from "@/app/components/shared/InlineNameInput";
import { RowActions } from "@/app/components/shared/RowActions";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { FolderBrowser, type FolderList } from "@/app/components/shared/FolderBrowser";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { useAuth } from "@/app/contexts/AuthContext";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { filenameExtensionChangeWarning, hasFilenameExtensionChange } from "@/app/lib/documentFilename";
import { formatUnsupportedDocumentWarning, partitionSupportedDocumentFiles,
    SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";
import { DOC_NAME_COL_W, treeNameCellStyle }
    from "@/app/components/projects/ProjectPageParts";
import { formatBytes, formatDate } from "@/app/lib/utils";
import { APP_SURFACE_ACTIVE_CLASS, APP_SURFACE_HOVER_CLASS }
    from "@/app/components/ui/liquid-surface";
import { TableHeaderCell, TableHeaderRow, TableScrollArea,
    TableLoadingState, TableSelectionCheckbox, TableStickyCell, useTableSelection }
    from "@/app/components/shared/TablePrimitive";
import { Button } from "@/app/components/ui/button";
import { getPdfJs } from "@/app/components/shared/views/highlightQuote";
import { DocumentSidePanel } from "@/app/components/shared/DocumentSidePanel";
import type { DocumentSelectionActions, UploadActions } from "./UploadAction";
import type { WorkflowSelection } from "@/app/components/workflows/workflowRoutes";
import { ContextualWorkflowPicker } from "@/app/components/workflows/ContextualWorkflowPicker";
import { Modal } from "@/app/components/modals/Modal";
import { isResearchDocument, researchLabelPath, type ResearchFile, type ResearchSourceReference } from "@/app/lib/researchFiles";
import { actOnResearchFile, getResearchFile } from "@/app/lib/api/researchFiles";
import { FileDirectory } from "../shared/FileDirectory";
import { CHAT_DOCUMENT_DRAG_TYPE, descendantFolderIds, DOCUMENT_DRAG_TYPE,
    documentTreeDropFolder, FOLDER_DRAG_TYPE, hasDocumentTreeDrag } from "./documentTree";
import { useFolderInteractions } from "./useFolderInteractions";
import { useDocumentController } from "./useDocumentController";
export type DocTableFolder = ProjectFolder | LibraryFolder;
const DOCUMENT_ROW_CLASS =
    "group flex h-11 min-h-11 w-full min-w-0 items-center border-b border-gray-100 pr-2 [content-visibility:auto] [contain-intrinsic-size:auto_44px]";
const DOCUMENT_METADATA_COLUMNS = [
    { label: "Type", row: "document-metadata ml-auto hidden w-20 shrink-0 sm:block",
        header: "document-metadata ml-auto hidden w-20 items-center gap-1 sm:flex" },
    { label: "Size", row: "document-metadata hidden w-24 shrink-0 md:block",
        header: "document-metadata hidden w-24 items-center gap-1 md:flex" },
    { label: "Version", row: "document-metadata hidden w-20 shrink-0 sm:block",
        header: "document-metadata hidden w-20 items-center gap-1 sm:flex" },
    { label: "Created", row: "document-metadata hidden w-32 shrink-0 lg:block",
        header: "document-metadata hidden w-32 items-center gap-1 lg:flex" },
    { label: "Updated", row: "document-metadata hidden w-32 shrink-0 xl:block",
        header: "document-metadata hidden w-32 items-center gap-1 xl:flex" },
] as const;
const DOCUMENT_METADATA_HEADERS = DOCUMENT_METADATA_COLUMNS.map(({ label, header }) =>
    <TableHeaderCell key={label} className={`${header} justify-center text-center`}><span>{label}</span></TableHeaderCell>);
const FOLDER_METADATA_CELLS = DOCUMENT_METADATA_COLUMNS.map(({ label, row }) => (
    <div key={label}
        className={`${row} text-center ${label === "Type" ? "text-xs" : "text-sm"} text-gray-300`}>
        —
    </div>
));
const BLANK_METADATA_CELLS = DOCUMENT_METADATA_COLUMNS.map(({ label, row }) =>
    <div key={label} className={row} />);
const EMPTY_METADATA_VALUE = <span className="text-gray-300">—</span>;
const WARNING_KINDS = ["upload", "rename", "collection"] as const;
function prewarmDocumentView(doc: Document) {
    const type = (doc.file_type ?? doc.filename.split(".").pop() ?? "")
        .toLowerCase().replace(/^\./u, "");
    if (type === "pdf" || doc.pdf_storage_path) void getPdfJs().catch(() => undefined);
}
/**
 * Structural-parse lifecycle chip beside the filename. Nothing for docs
 * without a parse lane (non-PDF, cloud) or a clean ready parse; flat text
 * always remains readable, so the chip reports the STRUCTURAL lane only.
 */
function ParseStateChip({ doc, onRetry }: { doc: Document; onRetry?: () => void }) {
    const state = doc.parse_state;
    if (!state) return null;
    if (state.status === "queued" || state.status === "parsing") {
        const page = state.pages?.length === 1 ? ` page ${state.pages[0]}` : "";
        const label = state.status === "queued" ? "Queued"
            : state.phase === "ocr" ? `OCR${page}`
                : state.phase === "inspecting" ? `Inspecting${page}`
                    : state.phase === "extracting" ? `Extracting${page}`
                        : "Preparing";
        return <span role="status" aria-live="polite"
            title={`${label} for ${doc.filename}`}
            className="ml-2 inline-flex shrink-0 items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />{label}</span>;
    }
    if (state.status === "degraded") {
        const label = state.phase === "ocr" ? "OCR · Degraded" : "Degraded";
        return <span
            title={state.phase === "ocr"
                ? "OCR completed, but some document structure may be uncertain"
                : "Parsed with reduced structure; flat text remains available"}
            aria-label={label}
            className="ml-2 hidden shrink-0 items-center gap-1 rounded-full bg-amber-50 p-1 text-xs text-amber-700 @min-[14rem]/document-name:inline-flex @min-[28rem]/document-name:px-2">
            <TriangleAlert aria-hidden="true" className="size-3.5" />
            <span className="hidden @min-[28rem]/document-name:inline">{label}</span></span>;
    }
    if (state.status === "failed" || state.status === "cancelled") {
        const label = state.status === "cancelled" ? "Processing cancelled" : "Parse failed";
        return <span
            title={state.error ?? "Structural PDF parse failed; flat text remains available"}
            className="ml-2 inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">
            {label}
            {onRetry && <button type="button" className="underline"
                aria-label={`Retry structural parse for ${doc.filename}`}
                onClick={(event) => { event.stopPropagation(); onRetry(); }}>
                Retry</button>}</span>;
    }
    return null;
}
function DocumentMetadataCells({ doc, onOpen }: { doc: Document; onOpen: () => void }) {
    const version = doc.active_version_number ?? null;
    const values: Record<(typeof DOCUMENT_METADATA_COLUMNS)[number]["label"], ReactNode> = {
        Type: doc.file_type ?? EMPTY_METADATA_VALUE,
        Size: doc.size_bytes == null ? EMPTY_METADATA_VALUE : formatBytes(doc.size_bytes),
        Version: typeof version === "number" && version > 0 ? (
                <button type="button" onClick={onOpen}
                    onPointerEnter={() => prewarmDocumentView(doc)}
                    onFocus={() => prewarmDocumentView(doc)}
                    className={`flex h-8 min-w-8 items-center justify-center rounded-md px-2 ${APP_SURFACE_HOVER_CLASS}`}
                    title="Open version history"
                    aria-label={`Open version history for ${doc.filename}`}>{version}</button>
            ) : EMPTY_METADATA_VALUE,
        Created: doc.created_at ? formatDate(doc.created_at) : EMPTY_METADATA_VALUE,
        Updated: doc.updated_at ? formatDate(doc.updated_at) : EMPTY_METADATA_VALUE,
    };
    return DOCUMENT_METADATA_COLUMNS.map(({ label, row }) => (
        <div key={label}
            className={`${row} text-center ${label === "Type" ? "text-xs uppercase" : "text-sm"} ${label === "Version" ? "flex items-center justify-center gap-1" : "truncate"} text-gray-500`}
            onClick={label === "Version" ? (event) => event.stopPropagation() : undefined}>
            {values[label]}</div>
    ));
}
interface DocTableOperations {
    list: FolderList;
    removeDocument?: (documentId: string) => Promise<void>;
    uploadDocument: (file: File) => Promise<Document>;
    uploadDocuments: (files: File[]) => Promise<Document[]>;
    uploadDirectory: (files: File[]) => Promise<Document[]>;
    refreshCollection: (parentFolderId?: string | null) => Promise<void>;
    refreshDocumentParseStates: (documentIds: string[]) => Promise<void>;
    /** Requeue a failed structural PDF parse (library lanes only). */
    retryPdfParse?: (documentId: string) => Promise<unknown>;
    createFolder: (name: string, parentFolderId?: string | null) => Promise<DocTableFolder>;
    renameFolder: (folderId: string, name: string) => Promise<DocTableFolder>;
    deleteFolder: (folderId: string) => Promise<void>;
    moveFolder: (folderId: string, parentFolderId: string | null) => Promise<DocTableFolder>;
    moveDocument: (documentId: string, folderId: string | null) => Promise<Document>;
    renameDocument: (documentId: string, filename: string) => Promise<Document>;
}
type PendingDocumentRemoval = { documents: Document[]; fromSelection: boolean; deleting: boolean };
type PendingFolderDeletion = { folder: DocTableFolder; deleting: boolean };
type PendingMove = { documentIds: string[] } | { folderId: string };
const emphasis = (value: ReactNode) =>
    <span className="font-medium text-gray-950">{value}</span>;
const count = (total: number, one: string, many = `${one}s`) =>
    `${total} ${total === 1 ? one : many}`;
function without<T>(current: Set<T>, values: Iterable<T>) {
    const next = new Set(current);
    for (const value of values) next.delete(value);
    return next;
}
function documentRemovalMessage(pending: PendingDocumentRemoval | null,
    detaches: boolean, versionCount?: number) {
    if (!pending) return;
    if (pending.fromSelection) {
        const total = pending.documents.length;
        return detaches
            ? `Remove ${count(total, "selected document")} from this project? The Library files and their links in other projects will be kept.`
            : `Permanently delete ${count(total, "selected document and all of its versions", "selected documents and all of their versions")}?`;
    }
    const name = emphasis(pending.documents[0].filename);
    return <div className="space-y-2"><p>{detaches
        ? <>Remove {name} from this project? The Library file and its links in other projects will be kept.</>
        : versionCount
          ? <>{name} has {count(versionCount, "version")}. Deleting this document will delete all of its versions.</>
          : <>Delete {name}? This will delete the document and all of its versions.</>}
    </p></div>;
}
function MoveDialog({ title, list, createFolder, rootLabel, disabledIds, canMove, onClose, onMove }: {
    title: string; list: FolderList; createFolder: DocTableOperations["createFolder"]; rootLabel: string; disabledIds?: Set<string>;
    canMove: (destinationId: string | null) => boolean;
    onClose: () => void; onMove: (destinationId: string | null) => Promise<void>;
}) {
    const [destination, setDestination] = useState<ProjectFolder | null>(null);
    const [moving, setMoving] = useState(false), [error, setError] = useState("");
    const destinationId = destination?.id ?? null;
    async function move() {
        if (moving || !canMove(destinationId)) return;
        setMoving(true); setError("");
        try { await onMove(destinationId); }
        catch (reason) {
            console.error("move failed", reason);
            setError(reason instanceof Error ? reason.message : "This item could not be moved.");
            setMoving(false);
        }
    }
    const close = () => { if (!moving) onClose(); };
    return <Modal open onClose={close} breadcrumbs={["Move", title]}
        size="md" className="!h-[min(32rem,calc(100dvh-2rem))]"
        footerStatus={<span role="status" aria-live="polite"
            className={error ? "text-sm text-red-700" : "text-sm text-gray-500"}>
            {error || `Destination: ${destination?.name ?? rootLabel}`}
        </span>}
        primaryAction={{ label: moving ? "Moving…" : "Move here",
            onClick: () => void move(), disabled: moving || !canMove(destinationId) }}>
        <FolderBrowser list={list} createFolder={createFolder} rootLabel={rootLabel} onSelect={(folder) => {
            setDestination(folder); setError("");
        }}
            disabledIds={disabledIds} />
    </Modal>;
}
function ResearchSetPicker({ onSelect, onClose }: { onSelect: (id: string, labelId?: string) => Promise<void>; onClose: () => void }) {
    const [picked, setPicked] = useState<Document[]>([]), [file, setFile] = useState<ResearchFile | null>(null);
    const [labelId, setLabelId] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const id = picked[0]?.id;
    useEffect(() => {
        let active = true; setFile(null); setLabelId(""); setError("");
        if (id) void getResearchFile(id).then((next) => { if (active) setFile(next); })
            .catch((reason) => { if (active) setError(String(reason)); });
        return () => { active = false; };
    }, [id]);
    return <Modal open onClose={onClose} breadcrumbs={["Add to research"]} size="lg"
        primaryAction={{ label: "Add", disabled: !file || busy, onClick: async () => {
            if (!file) return; setBusy(true); setError("");
            try { await onSelect(file.document.id, labelId || undefined); } catch (reason) { setError(String(reason)); }
            finally { setBusy(false); }
        } }} footerStatus={error && <p role="alert" className="text-sm text-red-700">{error}</p>}>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
            <FileDirectory selectedDocuments={picked} onChange={setPicked} showTabs multiple={false} documentFilter={isResearchDocument} noun="research sets" initialLocation={{ library: "files" }} />
            {file && <select aria-label="Destination source label" value={labelId} onChange={(event) => setLabelId(event.target.value)} className="w-full rounded border border-gray-300 p-2 text-sm">
                <option value="">All sources</option>{Object.values(file.state.labels).filter(({ scope }) => scope === "source").map(({ id }) =>
                    <option key={id} value={id}>{researchLabelPath(file.state.labels, id).map(({ name }) => name).join(" › ")}</option>)}
            </select>}
        </div>
    </Modal>;
}
interface DocTableProps {    scopeKey: string; documents: Document[]; folders: DocTableFolder[];
    initialDocument?: { id: string; versionId?: string | null; sheet?: string | null; cell?: string | null };
    loading: boolean; active?: boolean; search: string; operations: DocTableOperations; emptyDropLabel?: string;
    renderAddDocumentsModal?: (open: boolean, onClose: () => void,
        onSelect: (documents: Document[]) => void) => ReactNode;
    onUploadActionsChange?: (actions: UploadActions | null) => void;
    onCreateFolderActionChange?: (action: (() => void) | null) => void;
    onSelectionActionsChange?: (actions: DocumentSelectionActions | null) => void;
    onOpenInChat?: (documents: Document[]) => void;
    onOpenWorkflows?: (documents: Document[]) => void;
    onAssistantWorkflowSelect?: (selection: WorkflowSelection, documents: Document[]) => void;
    onOwnerOnlyAction?: Dispatch<SetStateAction<string | null>>;
    documentRemovalMode?: "delete" | "detach"; selectionFirst?: boolean;
    compact?: boolean;
    hasMoreParents?: Set<string | null>;
    loadingParents?: Set<string | null>;
    onFolderExpanded?: (folderId: string) => void;
    onLoadMore?: (parentId: string | null) => void;
}
export function DocTable({
    scopeKey, documents, folders, loading, active = true, search, operations,
    emptyDropLabel = "Drop PDF, Word, Excel, or PowerPoint files here",
    renderAddDocumentsModal, onUploadActionsChange,
    onCreateFolderActionChange, onSelectionActionsChange, onOpenWorkflows,
    onOpenInChat, onAssistantWorkflowSelect, onOwnerOnlyAction,
    documentRemovalMode = "delete", selectionFirst = false, compact = false,
    hasMoreParents = new Set(), loadingParents = new Set(),
    onFolderExpanded, onLoadMore, initialDocument,
}: DocTableProps) {
    const { user } = useAuth();
    const [addDocsOpen, setAddDocsOpen] = useState(false);
    const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
    const [renamingDocumentId, setRenamingDocumentId] = useState<string | null>(null);
    const [dragOverSurface, setDragOverSurface] =
        useState<"root" | `version:${string}` | null>(null);
    const [uploadingDroppedFilenames, setUploadingDroppedFilenames] = useState<string[]>([]);
    const [deletingDocIds, setDeletingDocIds] = useState(() => new Set<string>());
    const [warnings, setWarnings] = useState<Record<(typeof WARNING_KINDS)[number], string | null>>(
        () => ({ upload: null, rename: null, collection: null }));
    const [pendingDocumentRemoval, setPendingDocumentRemoval] =
        useState<PendingDocumentRemoval | null>(null);
    const [pendingDeleteFolder, setPendingDeleteFolder] = useState<PendingFolderDeletion | null>(null);
    const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
    const [folderTaskId, setFolderTaskId] = useState<string | null>(null);
    const [folderWorkflowDocuments, setFolderWorkflowDocuments] = useState<Document[] | null>(null);
    const { tree, expanded: expandedFolderIds, setExpanded: setExpandedFolderIds,
        editor: folderEditor, setEditor: setFolderEditor, startEditor: startFolderEditor,
        commitEditor: commitFolderEditor, toggleFolder, dragTarget: folderDragTarget,
        setDragTarget: setFolderDragTarget, canMove: canMoveTreeItem, move: moveTreeItem,
        drop: dropTreeItem } = useFolderInteractions({
        documents, folders, search, hasMoreParents, onFolderExpanded,
        async onCreateFolder(parent, name) {
            const folder = await operations.createFolder(name, parent);
            await refreshCollection(parent);
            return folder;
        },
        async onRenameFolder(id, name) {
            await operations.renameFolder(id, name);
            await refreshCollection(tree.folderById.get(id)?.parent_folder_id);
        },
        async onMoveDocument(id, destination, parent) {
            await operations.moveDocument(id, destination);
            await refreshParents(parent, destination);
        },
        async onMoveFolder(id, destination, parent) {
            await operations.moveFolder(id, destination);
            await refreshParents(parent, destination);
        },
    });
    const renamingFolderId = folderEditor?.kind === "rename" ? folderEditor.folderId : null;
    const dragOverFolderId = folderDragTarget ?? null;
    const controller = useDocumentController(documents, operations.refreshCollection,
        (message) => setWarning("collection", message), initialDocument);
    const { docsById, doc: viewingDoc, versionId: viewingDocVersionId, pendingRestore } = controller;
    const documentUploadInputRef = useRef<HTMLInputElement>(null);
    const directoryUploadInputRef = useRef<HTMLInputElement>(null);
    const loadingRef = useRef(loading);
    const renderAddDocumentsModalRef = useRef(renderAddDocumentsModal);
    const detachesDocument = documentRemovalMode === "detach";
    const ownerOnlyDocAction = detachesDocument
        ? "remove this document from the project" : "delete this document";
    const refreshCollection = operations.refreshCollection;
    const activePreparationIds = documents.flatMap(({ id, parse_state: parseState }) =>
        parseState?.status === "queued" || parseState?.status === "parsing" ? [id] : []);
    const activePreparationKey = activePreparationIds.join("\0");
    const refreshActiveDocuments = useEffectEvent(() =>
        operations.refreshDocumentParseStates(activePreparationIds));
    useEffect(() => {
        if (!active || !activePreparationKey) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            if (!stopped && document.visibilityState === "visible") {
                try { await refreshActiveDocuments(); }
                catch (error) { console.error("PDF preparation refresh failed", error); }
            }
            if (!stopped) timer = setTimeout(poll, 500);
        };
        timer = setTimeout(poll, 500);
        return () => { stopped = true; clearTimeout(timer); };
    }, [active, activePreparationKey]);
    useEffect(() => {
        loadingRef.current = loading;
        renderAddDocumentsModalRef.current = renderAddDocumentsModal;
    }, [loading, renderAddDocumentsModal]);
    const openAddDocuments = useCallback(() => {
        if (loadingRef.current) return;
        if (renderAddDocumentsModalRef.current) setAddDocsOpen(true);
        else documentUploadInputRef.current?.click();
    }, []);
    function handleUploadNewVersion(doc: Document) {
        versionUploadTargetDocRef.current = doc;
        window.setTimeout(() => versionUploadInputRef.current?.click(), 0);
    }
    async function handleVersionUploadInputChange(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0] ?? null;
        e.target.value = "";
        const doc = versionUploadTargetDocRef.current;
        versionUploadTargetDocRef.current = null;
        if (!file || !doc) return;
        await handleDropDocumentVersions(doc, [file]);
    }
    const versionUploadInputRef = useRef<HTMLInputElement>(null);
    const versionUploadTargetDocRef = useRef<Document | null>(null);
    function setWarning(kind: (typeof WARNING_KINDS)[number], message: string | null) {
        setWarnings((current) => current[kind] === message ? current : { ...current, [kind]: message });
    }
    const openCreateFolder = useCallback(() => {
        if (loadingRef.current) return;
        startFolderEditor({ kind: "new", parentId: null });
    }, [startFolderEditor]);
    const openUploadFolder = useCallback(() => {
        if (!loadingRef.current) directoryUploadInputRef.current?.click();
    }, []);
    useEffect(() => {
        onUploadActionsChange?.({ files: openAddDocuments, folder: openUploadFolder });
        onCreateFolderActionChange?.(openCreateFolder);
        return () => {
            onUploadActionsChange?.(null);
            onCreateFolderActionChange?.(null);
        };
    }, [onCreateFolderActionChange, onUploadActionsChange,
        openAddDocuments, openCreateFolder, openUploadFolder]);
    useEffect(() => {
        setSelectedDocIds((current) => (current.length ? [] : current));
    }, [scopeKey]);
    const [pickerDoc, setPickerDoc] = useState<Document | null>(null);
    async function addDocToWorkspace(doc: Document, workspaceId: string, labelId?: string) {
        try {
            const target = await getResearchFile(workspaceId);
            const versionId = doc.current_version_id
                ?? (await controller.load(doc.id))?.currentVersionId;
            if (!versionId) throw new Error("Document revision is unavailable");
            const reference: ResearchSourceReference = { provider: "library",
                kind: "document", id: doc.id, versionId, title: doc.filename };
            await actOnResearchFile(target.document.id, target.versionId, target.workingRevision,
                { type: "source", reference, ...(labelId ? { labelIds: [labelId] } : {}) });
            setPickerDoc(null);
        } catch (reason) {
            setWarning("collection", reason instanceof Error ? reason.message
                : "Could not add this document to the workspace");
            throw reason;
        }
    }
    function removeDocument(doc: Document) {
        return operations.removeDocument?.(doc.id) ?? deleteDocument(doc);
    }
    const selection = useTableSelection(tree.visibleDocuments, selectedDocIds, setSelectedDocIds);
    const refreshParents = useCallback((...parents: (string | null | undefined)[]) =>
        Promise.all([...new Set(parents.map((id) => id ?? null))]
            .map(refreshCollection)), [refreshCollection]);
    async function openFolder(folderId: string, action: (documents: Document[]) => void) {
        if (folderTaskId) return;
        setFolderTaskId(folderId); setWarning("collection", null);
        try {
            const selected = await listDirectoryDocuments(operations.list, folderId);
            if (selected.length) action(selected);
            else setWarning("collection", "There are no documents in this folder.");
        } catch {
            setWarning("collection", "The folder could not be opened. Try again.");
        } finally { setFolderTaskId(null); }
    }
    function requestDeleteFolder(folderId: string) {
        const folder = tree.folderById.get(folderId);
        if (!folder) return;
        setPendingDeleteFolder({ folder, deleting: false });
    }
    async function confirmDeletePendingFolder() {
        const pending = pendingDeleteFolder;
        if (!pending || pending.deleting) return;
        setPendingDeleteFolder((current) =>
            current ? { ...current, deleting: true } : current);
        try {
            await operations.deleteFolder(pending.folder.id);
            const toDelete = descendantFolderIds(pending.folder.id, tree.foldersByParent);
            const deletedDocIds = new Set(documents
                .filter(({ folder_id }) => folder_id && toDelete.has(folder_id))
                .map(({ id }) => id));
            setExpandedFolderIds((prev) => without(prev, toDelete));
            if (renamingFolderId && toDelete.has(renamingFolderId))
                setFolderEditor(null);
            setSelectedDocIds((prev) => prev.filter((id) => !deletedDocIds.has(id)));
            controller.forget(deletedDocIds);
            setPendingDeleteFolder(null);
            await refreshCollection(pending.folder.parent_folder_id ?? null);
        } catch (err) {
            console.error("delete folder failed", err);
            setPendingDeleteFolder((current) =>
                current ? { ...current, deleting: false } : current);
            setWarning("collection", "Folder could not be deleted. Please try again.");
        }
    }
    async function movePending(destinationId: string | null) {
        if (!pendingMove) return;
        if ("folderId" in pendingMove) {
            await moveTreeItem({ kind: "folder", id: pendingMove.folderId }, destinationId);
        } else {
            const documentsToMove = pendingMove.documentIds
                .map((id) => docsById.get(id))
                .filter((doc): doc is Document =>
                    !!doc && (doc.folder_id ?? null) !== destinationId);
            const results = await Promise.allSettled(documentsToMove.map((doc) =>
                operations.moveDocument(doc.id, destinationId)));
            await refreshParents(destinationId,
                ...documentsToMove.map(({ folder_id }) => folder_id));
            if (results.some(({ status }) => status === "rejected"))
                throw new Error("Some documents could not be moved.");
        }
        setPendingMove(null);
    }
    async function retryParse(docId: string) {
        if (!operations.retryPdfParse) return;
        try {
            await operations.retryPdfParse(docId);
        } finally {
            await operations.refreshCollection();
        }
    }
    async function submitDocumentRename(docId: string, value: string): Promise<boolean> {
        const previous = docsById.get(docId) ?? (viewingDoc?.id === docId ? viewingDoc : null);
        if (!previous || !value.trim()) return false;
        const name = isResearchDocument(previous)
            ? `${value.trim().replace(/\.research\.md$/iu, "")}.research.md` : value.trim();
        if (hasFilenameExtensionChange(previous.filename, name)) {
            setWarning("rename", filenameExtensionChangeWarning(previous.filename));
            return false;
        }
        const renamed = name === previous.filename || await controller.action(docId, "rename", () =>
            operations.renameDocument(docId, name), true);
        if (renamed) setRenamingDocumentId(null);
        return renamed;
    }
    async function handleRemoveDocuments(documentsToRemove: Document[],
        fromSelection: boolean) {
        const owned = documentsToRemove.filter((doc) =>
            !doc.user_id || !user?.id || doc.user_id === user.id);
        const blocked = documentsToRemove.length - owned.length;
        if (!fromSelection && blocked) return onOwnerOnlyAction?.(ownerOnlyDocAction);
        if (fromSelection) setSelectedDocIds([]);
        else setDeletingDocIds((prev) =>
            new Set([...prev, ...owned.map(({ id }) => id)]));
        try {
            const results = await Promise.allSettled(owned.map(removeDocument));
            const removedIds = new Set(owned
                .filter((_, index) => results[index].status === "fulfilled")
                .map(({ id }) => id));
            if (removedIds.size) {
                await refreshParents(...owned
                    .filter(({ id }) => removedIds.has(id)).map(({ folder_id }) => folder_id));
                controller.forget(removedIds);
            }
            if (!fromSelection) {
                const failure = results.find((result): result is PromiseRejectedResult =>
                    result.status === "rejected");
                if (failure) throw failure.reason;
                return;
            }
            const failed = owned.length - removedIds.size;
            if (failed) setWarning("collection",
                `${failed} ${failed === 1 ? "document" : "documents"} could not be ${
                    detachesDocument ? "removed from this project" : "deleted"
                }. Please try again.`);
            if (blocked) onOwnerOnlyAction?.(detachesDocument
                ? `remove ${blocked} of the selected documents \u2014 only the document creator can remove a document from this project`
                : `delete ${blocked} of the selected documents \u2014 only the document creator can delete a document`);
        } finally {
            if (!fromSelection)
                setDeletingDocIds((prev) => without(prev, owned.map(({ id }) => id)));
        }
    }
    function requestRemoveDoc(doc: Document) {
        if (doc && user?.id && doc.user_id && doc.user_id !== user.id)
            return onOwnerOnlyAction?.(ownerOnlyDocAction);
        setPendingDocumentRemoval({ documents: [doc], fromSelection: false, deleting: false });
    }
    function hasFilePayload(dt: DataTransfer): boolean {
        return dt.types.includes("Files");
    }
    function clearDragOver() {
        setFolderDragTarget(undefined);
        setDragOverSurface(null);
    }
    function acceptedFiles(files: File[]) {
        if (!files.length) return [];
        const { supported, unsupported } =
            partitionSupportedDocumentFiles(files);
        setWarning("upload", formatUnsupportedDocumentWarning(unsupported));
        return supported;
    }
    async function uploadCollection(files: File[], directory = false) {
        const supported = acceptedFiles(files);
        if (supported.length === 0) return;
        setUploadingDroppedFilenames(supported.map((file) => file.name));
        try {
            await (directory ? operations.uploadDirectory : operations.uploadDocuments)(supported);
        } catch (err) {
            console.error(directory ? "Folder upload failed" : "Document drop upload failed", err);
            setWarning("upload", directory
                ? "The folder was only partly uploaded. Try the missing files again."
                : "Some files could not be uploaded. Try those files again.");
        } finally {
            await Promise.resolve(refreshCollection()).catch(() => undefined);
            setUploadingDroppedFilenames([]);
        }
    }
    function handleDropDocumentVersions(doc: Document, files: File[]) {
        return controller.upload(doc, acceptedFiles(files));
    }
    function handleDocumentVersionDragOver(
        e: DragEvent<HTMLDivElement>,
        docId: string,
    ) {
        if (!hasFilePayload(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragOverSurface(`version:${docId}`);
    }
    function handleDocumentVersionDragLeave(e: DragEvent<HTMLDivElement>) {
        if (!e.currentTarget.contains(e.relatedTarget as Node) && dragOverSurface?.startsWith("version:"))
            setDragOverSurface(null);
    }
    function handleDocumentVersionDrop(e: DragEvent<HTMLDivElement>, doc: Document) {
        if (!hasFilePayload(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        clearDragOver();
        void handleDropDocumentVersions(doc, Array.from(e.dataTransfer.files));
    }
    function renderDocumentActivityRow({ key, filename, fileType, depth, statusLabel }: {
        key: string; filename: string; fileType: string | null;
        depth: number; statusLabel: string;
    }) {
        return (
            <div key={key} className={DOCUMENT_ROW_CLASS}>
                <div className={`${DOC_NAME_COL_W} @container/document-name py-2 pl-4 pr-2`}
                    style={treeNameCellStyle(depth)}>
                    <div className="flex items-center">
                        <Loader2 className="mr-4 h-2.5 w-2.5 animate-spin text-gray-400 shrink-0" />
                        <span className="mr-2 shrink-0">
                            <FileTypeIcon fileType={fileType ?? filename}
                                className="h-4 w-4" muted />
                        </span>
                        <span className="text-sm text-gray-400 truncate">{filename}</span>
                    </div>
                </div>
                {DOCUMENT_METADATA_COLUMNS.map(({ label, row }) => (
                    <div key={label}
                        className={`${row} ${label === "Type" ? "text-xs uppercase truncate" : "text-sm"} text-gray-300`}>
                        {label === "Type"
                            ? fileType ?? (filename.includes(".") ? filename.split(".").pop() : "file")
                            : label === "Size" ? statusLabel : "—"}
                    </div>
                ))}
                <div className="w-8 shrink-0" />
            </div>
        );
    }
    function openDocument(doc: Document) {
        prewarmDocumentView(doc);
        controller.open(doc);
    }
    function selectAndOpen(doc: Document) {
        setSelectedDocIds([doc.id]);
        openDocument(doc);
    }
    function handleDocumentRowDoubleClick(event: React.MouseEvent<HTMLDivElement>,
        doc: Document) {
        if (!selectionFirst || (event.target instanceof Element &&
            event.target.closest("button, input, select, textarea")))
            return;
        selectAndOpen(doc);
    }
    function handleDocumentRowKeyDown(event: React.KeyboardEvent<HTMLDivElement>,
        doc: Document) {
        if (!selectionFirst || event.target !== event.currentTarget) return;
        if (event.key === "Enter") {
            event.preventDefault();
            selectAndOpen(doc);
        } else if (event.key === " ") {
            event.preventDefault();
            selection.toggle(doc.id);
        }
    }
    function handleDocumentDragStart(event: DragEvent<HTMLDivElement>, doc: Document) {
        if (renamingDocumentId === doc.id) return event.preventDefault();
        event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, doc.id);
        event.dataTransfer.setData(CHAT_DOCUMENT_DRAG_TYPE, JSON.stringify([doc]));
        event.dataTransfer.effectAllowed = "copyMove";
    }
    function handleFolderDragStart(event: DragEvent<HTMLDivElement>, folderId: string) {
        if (renamingFolderId === folderId) return event.preventDefault();
        event.dataTransfer.setData(FOLDER_DRAG_TYPE, folderId);
        event.dataTransfer.effectAllowed = "move";
        event.stopPropagation();
    }
    function handleCollectionDragOver(event: DragEvent<HTMLElement>) {
        if (hasFilePayload(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        } else if (hasDocumentTreeDrag(event.dataTransfer)) {
            event.preventDefault();
            const folderId = documentTreeDropFolder(event.target);
            setFolderDragTarget(folderId);
            setDragOverSurface(folderId ? null : "root");
        }
    }
    function handleCollectionDragLeave(event: DragEvent<HTMLElement>) {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
            clearDragOver();
    }
    async function handleCollectionDrop(event: DragEvent<HTMLElement>) {
        if (hasFilePayload(event.dataTransfer)) {
            event.preventDefault();
            void uploadCollection(Array.from(event.dataTransfer.files));
        } else if (hasDocumentTreeDrag(event.dataTransfer)) {
            event.preventDefault();
            const folderId = documentTreeDropFolder(event.target);
            clearDragOver();
            await dropTreeItem(event.dataTransfer, folderId);
        }
    }
    function renderRows() {
        return (
            <>
                {uploadingDroppedFilenames.map((filename) =>
                    renderDocumentActivityRow({
                        key: `uploading-doc-${filename}`, filename,
                        fileType: null, depth: 0, statusLabel: "Uploading",
                    }),
                )}
                {tree.rows.map((row) => {
                    if (row.kind === "more") return (
                        <div key={`more-${row.parentId ?? "root"}`}
                            className={DOCUMENT_ROW_CLASS}>
                            <div className={`${DOC_NAME_COL_W} @container/document-name py-2 pl-4 pr-2`}
                                style={treeNameCellStyle(row.depth)}>
                                <Button variant="outline" size="compact"
                                    disabled={loadingParents.has(row.parentId)}
                                    onClick={() => onLoadMore?.(row.parentId)}
                                    className="ml-8">
                                    {loadingParents.has(row.parentId) ? "Loading…" : "Load more"}
                                </Button>
                            </div>
                        </div>
                    );
                    if (row.kind === "editor") return (
                        <div ref={(element) => element?.scrollIntoView({ block: "nearest" })}
                            key={`new-folder-${row.parentId ?? "root"}`}
                            data-tree-drop-folder={row.parentId ?? ""}
                            className={DOCUMENT_ROW_CLASS}>
                            <div className={`${DOC_NAME_COL_W} @container/document-name py-2 pl-4 pr-2`}
                                style={treeNameCellStyle(row.depth)}>
                                <div className="flex items-center">
                                    <span className="mr-4 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                                        <ChevronRight className="h-3.5 w-3.5 text-gray-300" />
                                    </span>
                                    <FolderSvgIcon className="mr-2 h-4 w-4 shrink-0" />
                                    <InlineNameInput kind="new-folder"
                                        onCommit={(name) =>
                                            void commitFolderEditor(name)}
                                        onCancel={() => setFolderEditor(null)} />
                                </div>
                            </div>
                            {BLANK_METADATA_CELLS}
                            <div className="w-8 shrink-0" />
                        </div>
                    );
                    if (row.kind === "folder") {
                        const folder = row.folder;
                        const isExpanded = expandedFolderIds.has(folder.id);
                        const isRenaming = renamingFolderId === folder.id;
                        const isDragOver = dragOverFolderId === folder.id;
                        const folderPrefix = <><span
                            className="mr-4 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                            {isExpanded
                                ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                                : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
                        </span><FolderSvgIcon open={isExpanded}
                            className="mr-2 h-4 w-4 shrink-0" /></>;
                        return (
                            <div key={`folder-${folder.id}`}
                                data-tree-drop-folder={folder.id}
                                draggable={!isRenaming}
                                onDragStart={(event) => handleFolderDragStart(event, folder.id)}
                                className={`${DOCUMENT_ROW_CLASS} ${isRenaming ? "" : "select-none"} ${isDragOver ? "bg-red-50 ring-1 ring-inset ring-red-200" : `bg-app-surface ${APP_SURFACE_HOVER_CLASS}`}`}>
                                <div className={`${DOC_NAME_COL_W} @container/document-name py-2 pl-4 pr-2`}
                                    style={treeNameCellStyle(row.depth)}>
                                    {isRenaming ? <div className="flex items-center">
                                        {folderPrefix}<InlineNameInput kind="folder"
                                                value={folder.name}
                                                onCommit={(value) =>
                                                    void commitFolderEditor(value)}
                                                onCancel={() => setFolderEditor(null)} />
                                    </div> : <button type="button" aria-expanded={isExpanded}
                                        onClick={() => toggleFolder(folder.id)}
                                        className="flex min-h-6 w-full cursor-pointer items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-red-600">
                                        {folderPrefix}<span className="truncate text-sm text-gray-800">
                                            {folder.name}</span>
                                    </button>}
                                </div>
                                {FOLDER_METADATA_CELLS}
                                <div className="flex w-8 shrink-0 justify-end">
                                    <RowActions
                                        additionalItems={[
                                            ...(onOpenInChat ? [{ label: "Open in new chat",
                                                disabled: !!folderTaskId,
                                                onSelect: () => void openFolder(folder.id, onOpenInChat) }] : []),
                                            ...(onOpenWorkflows || onAssistantWorkflowSelect ? [{ label: "Workflows",
                                                disabled: !!folderTaskId,
                                                onSelect: () => void openFolder(folder.id, (selected) => {
                                                    if (onOpenWorkflows) onOpenWorkflows(selected);
                                                    else setFolderWorkflowDocuments(selected);
                                                }) }] : []),
                                        ]}
                                        onNewSubfolder={() => startFolderEditor({ kind: "new", parentId: folder.id })}
                                        newSubfolderLabel="New subfolder inside"
                                        onRename={() => startFolderEditor({ kind: "rename", folderId: folder.id })}
                                        onMove={() => setPendingMove({ folderId: folder.id })}
                                        onDelete={() => requestDeleteFolder(folder.id)} />
                                </div>
                            </div>
                        );
                    }
                    const doc = row.document;
                    const docName = doc.filename;
                    const displayName = docName.replace(/\.research\.md$/iu, "");
                    const isProcessing = doc.parse_state?.status === "queued" ||
                        doc.parse_state?.status === "parsing";
                    const isError = doc.parse_state?.status === "failed";
                    const isVersionDragOver = dragOverSurface === `version:${doc.id}`;
                    const isUploadingVersion = controller.histories.get(doc.id)?.pendingAction === "upload";
                    const prewarm = () => prewarmDocumentView(doc);
                    const isSelected = selection.selected.has(doc.id);
                    const isDeletingDoc = deletingDocIds.has(doc.id);
                    if (isDeletingDoc) return renderDocumentActivityRow({
                        key: `deleting-doc-${doc.id}`, filename: doc.filename,
                        fileType: doc.file_type, depth: row.depth,
                        statusLabel: "Deleting...",
                    });
                    return (
                        <div key={`doc-${doc.id}`} data-document-row
                            data-tree-drop-folder={row.parentId ?? ""}
                            draggable={renamingDocumentId !== doc.id}
                            onDragStart={(event) => handleDocumentDragStart(event, doc)}
                            onDragOver={(event) => handleDocumentVersionDragOver(event, doc.id)}
                            onDragLeave={handleDocumentVersionDragLeave}
                            onDrop={(event) => handleDocumentVersionDrop(event, doc)}
                            onClick={selectionFirst ? undefined : () => openDocument(doc)}
                            onDoubleClick={(event) => handleDocumentRowDoubleClick(event, doc)}
                            onKeyDown={(event) => handleDocumentRowKeyDown(event, doc)}
                            tabIndex={selectionFirst ? 0 : undefined}
                            role={selectionFirst ? "row" : undefined}
                            aria-selected={selectionFirst ? isSelected : undefined}
                            className={`${DOCUMENT_ROW_CLASS} cursor-pointer ${selectionFirst ? "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600" : ""} ${isVersionDragOver ? "bg-red-50 ring-1 ring-inset ring-red-200" : isSelected ? APP_SURFACE_ACTIVE_CLASS : `bg-app-surface ${APP_SURFACE_HOVER_CLASS}`}`}>
                            <div className={`${DOC_NAME_COL_W} @container/document-name py-2 pl-4 pr-2`}
                                style={treeNameCellStyle(row.depth)}>
                                <div className="flex items-center">
                                    {isProcessing || isUploadingVersion ? (
                                        <span className="-ml-2 mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center">
                                            <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                                        </span>
                                    ) : (
                                        <TableSelectionCheckbox checked={isSelected}
                                            aria-label={`Select ${docName}`}
                                            onChange={(event) => selection.toggle(
                                                doc.id,
                                                (event.nativeEvent as MouseEvent).shiftKey,
                                            )} />
                                    )}
                                    <span className="mr-2 shrink-0">
                                        {isError
                                            ? <AlertCircle className="h-4 w-4 text-red-500" />
                                            : <FileTypeIcon fileType={doc.file_type} filename={doc.filename}
                                                className="h-4 w-4" />}
                                    </span>
                                    {renamingDocumentId === doc.id ? <InlineNameInput kind="document"
                                            value={docName}
                                            onCommit={(value) =>
                                                void submitDocumentRename(doc.id, value)}
                                            onCancel={() => setRenamingDocumentId(null)} />
                                        : selectionFirst ? (
                                        <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                                            {displayName}</span>
                                        ) : <button type="button" aria-label={`Open ${displayName}`}
                                            onClick={(event) => {
                                                event.stopPropagation(); openDocument(doc);
                                            }} onPointerEnter={prewarm} onFocus={prewarm}
                                            className="min-w-0 flex-1 truncate text-left text-sm text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-red-600">
                                            {displayName}</button>}
                                    <ParseStateChip doc={doc}
                                        onRetry={operations.retryPdfParse
                                            ? () => void retryParse(doc.id)
                                            : undefined} />
                                    {selectionFirst && (
                                        <Button size="compact"
                                            aria-label={`View ${docName}`}
                                            title={`View ${docName}`}
                                            disabled={renamingDocumentId === doc.id}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                selectAndOpen(doc);
                                            }}
                                            onPointerEnter={prewarm}
                                            onFocus={prewarm}
                                            className="ml-2 h-8 min-w-14 shrink-0 px-3 disabled:invisible @max-[16rem]/document-name:min-w-8 @max-[16rem]/document-name:px-0">
                                            <Eye className="hidden @max-[16rem]/document-name:block" aria-hidden="true" />
                                            <span className="@max-[16rem]/document-name:sr-only">View</span>
                                        </Button>
                                    )}
                                </div>
                            </div>
                            <DocumentMetadataCells doc={doc}
                                onOpen={() => openDocument(doc)} />
                            <div className="flex w-8 shrink-0 justify-end">
                                {!isProcessing && (
                                    <RowActions
                                        additionalItems={[
                                            { label: "Add to research…", onSelect: () => setPickerDoc(doc) },
                                        ]}
                                        onRename={() => setRenamingDocumentId(doc.id)}
                                        renameLabel="Rename document"
                                        onDownload={() => downloadDoc(doc.id)}
                                        onUploadNewVersion={() => void handleUploadNewVersion(doc)}
                                        onMove={() => setPendingMove({ documentIds: [doc.id] })}
                                        onDelete={() => requestRemoveDoc(doc)}
                                        deleteLabel={detachesDocument
                                            ? "Remove from project" : "Delete"}
                                        deleteDisabled={!!(doc.user_id && user?.id && doc.user_id !== user.id)} />
                                )}
                            </div>
                        </div>
                    );
                })}
            </>
        );
    }
    const downloadDoc = useCallback(async (docId: string) => {
        const { blob, filename } = await downloadDocument(docId);
        downloadBlob(blob, filename || docsById.get(docId)?.filename || "document");
    }, [docsById]);
    const handleDownloadSelectedDocs = useCallback(async () => {
        if (selectedDocIds.length === 1) {
            await downloadDoc(selectedDocIds[0]);
            return;
        }
        downloadBlob(await downloadDocumentsZip(selectedDocIds), "documents.zip");
    }, [downloadDoc, selectedDocIds]);
    const requestDeleteSelectedDocs = useCallback(async () => {
        const documentsToRemove = selectedDocIds
            .map((id) => docsById.get(id))
            .filter((document): document is Document => !!document);
        if (!documentsToRemove.length) return;
        setPendingDocumentRemoval({ documents: documentsToRemove, fromSelection: true, deleting: false });
    }, [docsById, selectedDocIds]);
    async function confirmPendingDocumentRemoval() {
        const pending = pendingDocumentRemoval;
        if (!pending || pending.deleting) return;
        setPendingDocumentRemoval((current) =>
            current ? { ...current, deleting: true } : current);
        try {
            await handleRemoveDocuments(pending.documents, pending.fromSelection);
            setPendingDocumentRemoval(null);
        } catch (err) {
            if (pending.fromSelection) throw err;
            console.error("delete document failed", err);
            setPendingDocumentRemoval((current) =>
                current ? { ...current, deleting: false } : current);
            setWarning("collection", detachesDocument
                ? "The document could not be removed from this project. Please try again."
                : "The document could not be deleted. Please try again.");
        }
    }
    const selectionActions = useMemo<DocumentSelectionActions | null>(() => {
        if (selectedDocIds.length === 0) return null;
        return {
            documents: selectedDocIds
                .map((id) => docsById.get(id))
                .filter((document): document is Document => !!document),
            onDownload: handleDownloadSelectedDocs,
            onMove: () => setPendingMove({ documentIds: selectedDocIds }),
            onRemove: requestDeleteSelectedDocs,
            removeLabel: detachesDocument ? "Remove" : "Delete",
        };
    }, [detachesDocument, docsById, selectedDocIds,
        handleDownloadSelectedDocs, requestDeleteSelectedDocs]);
    useEffect(() => onSelectionActionsChange?.(selectionActions),
        [onSelectionActionsChange, selectionActions]);
    useEffect(() => () => onSelectionActionsChange?.(null), [onSelectionActionsChange]);
    const pendingDeleteMessage = documentRemovalMessage(
        pendingDocumentRemoval, detachesDocument,
        pendingDocumentRemoval && !pendingDocumentRemoval.fromSelection
            ? controller.histories.get(pendingDocumentRemoval.documents[0].id)?.versions.length
            : undefined,
    );
    const pendingDeleteFolderMessage = pendingDeleteFolder ? <p>
        Permanently delete {emphasis(pendingDeleteFolder.folder.name)} and everything inside it?
    </p> : undefined;
    const pendingMoveTitle = pendingMove && ("folderId" in pendingMove
        ? tree.folderById.get(pendingMove.folderId)?.name ?? "Folder"
        : pendingMove.documentIds.length === 1
            ? docsById.get(pendingMove.documentIds[0])?.filename ?? "Document"
            : `${pendingMove.documentIds.length} documents`);
    const disabledMoveFolders = pendingMove && "folderId" in pendingMove
        ? descendantFolderIds(pendingMove.folderId, tree.foldersByParent) : undefined;
    const canMovePendingTo = (destinationId: string | null) => !!pendingMove &&
        ("folderId" in pendingMove
            ? canMoveTreeItem({ kind: "folder", id: pendingMove.folderId }, destinationId)
            : pendingMove.documentIds.some((id) =>
                (docsById.get(id)?.folder_id ?? null) !== destinationId));
    const isEmptyCollection = documents.length === 0 && folders.length === 0 &&
        folderEditor?.kind !== "new" && uploadingDroppedFilenames.length === 0;
    const rootLabel = scopeKey === "templates" ? "Templates"
        : scopeKey === "files" ? "Library" : "Project";
    return (
        <div className={`relative flex h-full min-h-0 flex-1 flex-col overflow-hidden ${compact ? "[&_.document-metadata]:hidden" : ""}`}
            onDragEnd={clearDragOver}>
            <input ref={versionUploadInputRef} type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT}
                className="hidden" onChange={handleVersionUploadInputChange} />
            <input ref={documentUploadInputRef} type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT} multiple className="hidden"
                onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    void uploadCollection(files);
                }} />
            <input ref={directoryUploadInputRef} type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT} multiple className="hidden"
                {...{ webkitdirectory: "", directory: "" }}
                onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    void uploadCollection(files, true);
                }} />
            {WARNING_KINDS.map((kind) => (
                <WarningPopup key={kind} open={!!warnings[kind]}
                    onClose={() => setWarning(kind, null)}
                    message={warnings[kind]} />
            ))}
            <ConfirmPopup open={!!pendingRestore} title="Restore this version?"
                message={`Version ${pendingRestore?.version.version_number} will become a new current version. Existing history will be kept.`}
                confirmLabel="Restore" confirmStatus={pendingRestore && controller.histories.get(pendingRestore.docId)?.pendingAction ? "loading" : "idle"}
                onCancel={() => { if (pendingRestore && !controller.histories.get(pendingRestore.docId)?.pendingAction) controller.setPendingRestore(null); }}
                onConfirm={() => void controller.restore()} />
            <ConfirmPopup open={!!pendingDocumentRemoval}
                title={detachesDocument ? "Remove from project?"
                    : pendingDocumentRemoval?.fromSelection
                        ? "Delete documents?" : "Delete document?"}
                message={pendingDeleteMessage}
                confirmLabel={detachesDocument ? "Remove" : "Delete"}
                confirmStatus={pendingDocumentRemoval?.deleting ? "loading" : "idle"}
                cancelLabel="Cancel"
                onCancel={() => { if (!pendingDocumentRemoval?.deleting)
                    setPendingDocumentRemoval(null); }}
                onConfirm={() => void confirmPendingDocumentRemoval()} />
            <ConfirmPopup open={!!pendingDeleteFolder} title="Delete folder?"
                message={pendingDeleteFolderMessage} confirmLabel="Delete"
                confirmStatus={pendingDeleteFolder?.deleting ? "loading" : "idle"}
                cancelLabel="Cancel"
                onCancel={() => { if (!pendingDeleteFolder?.deleting)
                    setPendingDeleteFolder(null); }}
                onConfirm={() => void confirmDeletePendingFolder()} />
            {pendingMove && <MoveDialog key={"folderId" in pendingMove
                ? pendingMove.folderId : pendingMove.documentIds.join("\0")}
                title={pendingMoveTitle ?? "Move"} list={operations.list} createFolder={operations.createFolder}
                rootLabel={rootLabel} disabledIds={disabledMoveFolders}
                canMove={canMovePendingTo}
                onClose={() => setPendingMove(null)} onMove={movePending} />}
            <Modal open={!!folderWorkflowDocuments}
                onClose={() => setFolderWorkflowDocuments(null)}
                size="xl" breadcrumbs={["Workflows"]}>
                <ContextualWorkflowPicker documents={folderWorkflowDocuments ?? []}
                    onAssistantSelect={onAssistantWorkflowSelect
                        ? (selection, selected) => onAssistantWorkflowSelect(selection, selected as Document[])
                        : undefined}
                    onLaunched={() => setFolderWorkflowDocuments(null)}
                    className="pb-4" />
            </Modal>
            {pickerDoc && (
                <ResearchSetPicker
                    onSelect={(workspaceId, labelId) => addDocToWorkspace(pickerDoc, workspaceId, labelId)}
                    onClose={() => setPickerDoc(null)} />
            )}
            <TableScrollArea className="document-table"
                header={<TableHeaderRow className="!min-w-0 w-full pr-2">
                    <TableStickyCell header widthClassName={DOC_NAME_COL_W}>
                        <TableSelectionCheckbox checked={selection.allSelected}
                            aria-label="Select loaded documents"
                            indeterminate={selection.someSelected}
                            onChange={selection.toggleAll} />
                        <span aria-hidden="true" className="mr-2 h-4 w-4 shrink-0" />
                        <span className="mr-1">Name</span>
                    </TableStickyCell>
                    {DOCUMENT_METADATA_HEADERS}
                    <TableHeaderCell className="w-8" />
                </TableHeaderRow>}
            >
                {loading && isEmptyCollection ? <TableLoadingState /> : (
                    <div className="relative flex min-h-0 flex-1 flex-col">
                        {dragOverSurface === "root" && dragOverFolderId === null && (
                            <div className="pointer-events-none absolute inset-0 z-[80] border-2 border-red-400" />
                        )}
                        {isEmptyCollection ? (
                            <button type="button" onClick={openAddDocuments}
                                onDragOver={handleCollectionDragOver}
                                onDragLeave={handleCollectionDragLeave}
                                onDrop={(event) => void handleCollectionDrop(event)}
                                className="flex w-full flex-1 cursor-pointer flex-col items-center justify-center py-24 text-center">
                                <FolderSvgIcon className="mb-3 h-8 w-8 text-gray-700" />
                                <p className="text-sm text-gray-400">{emptyDropLabel}</p>
                            </button>
                        ) : (
                            <div className="flex flex-1 flex-col"
                                onDragOver={handleCollectionDragOver}
                                onDragLeave={handleCollectionDragLeave}
                                onDrop={(event) => void handleCollectionDrop(event)}>
                                {renderRows()}
                                <div className="min-h-16 flex-1" />
                            </div>
                        )}
                    </div>
                )}
            </TableScrollArea>
            {renderAddDocumentsModal?.(addDocsOpen,
                () => setAddDocsOpen(false), () => void refreshCollection())}
            <DocumentSidePanel
                controller={controller}
                highlightCells={viewingDoc?.id === initialDocument?.id && viewingDocVersionId === (initialDocument?.versionId ?? null) ? [{ sheet: initialDocument?.sheet ?? undefined, cell: initialDocument?.cell ?? undefined }] : undefined}
                onRenameDocument={submitDocumentRename}
                onUploadNewVersion={handleUploadNewVersion}
                onOpenWorkflows={onOpenWorkflows}
                onAssistantWorkflowSelect={onAssistantWorkflowSelect}
                onDelete={requestRemoveDoc}
                documentRemovalMode={documentRemovalMode} />
        </div>
    );
}

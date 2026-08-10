import { type Dispatch, type DragEvent, type ReactNode, type SetStateAction,
    useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { deleteDocument, deleteDocumentVersion, downloadDocumentsZip,
    getDocumentUrl, listDocumentVersions, renameDocumentVersion,
    replaceDocumentVersionFile, uploadDocumentVersion,
    type DocumentVersion } from "@/app/lib/beaverApi";
import { downloadBlob, downloadUrl } from "@/app/lib/download";
import type { Document, Folder as ProjectFolder, LibraryFolder }
    from "@/app/components/shared/types";
import { RowActions } from "@/app/components/shared/RowActions";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { useAuth } from "@/app/contexts/AuthContext";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { filenameExtensionChangeWarning, hasFilenameExtensionChange }
    from "@/app/lib/documentFilename";
import { formatUnsupportedDocumentWarning, partitionSupportedDocumentFiles,
    SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";
import { DOC_NAME_COL_W, treeNameCellStyle }
    from "@/app/components/projects/ProjectPageParts";
import { formatBytes, formatDate } from "@/app/lib/utils";
import { DocumentSidePanel } from "@/app/components/shared/DocumentSidePanel";
import { APP_SURFACE_ACTIVE_CLASS, APP_SURFACE_HOVER_CLASS }
    from "@/app/components/ui/liquid-surface";
import { TableHeaderCell, TableHeaderRow, TableScrollArea,
    TableSelectionPlaceholder, TableStickyCell }
    from "@/app/components/shared/TablePrimitive";
import { CheckboxControl } from "@/app/components/ui/checkbox";
import { pillButtonClassName } from "@/app/components/ui/pill-button";
import { preloadSingleDoc } from "@/app/hooks/useFetchSingleDoc";
import { getPdfJs } from "@/app/components/shared/views/highlightQuote";
import { preloadDocxViewer } from "@/app/components/shared/views/DocumentViewer";
import { buildDocumentTree, descendantFolderIds, DOCUMENT_DRAG_TYPE,
    documentTreeDropFolder, FOLDER_DRAG_TYPE, hasDocumentTreeDrag,
    wouldCreateFolderCycle } from "./documentTree";
export type DocTableFolder = ProjectFolder | LibraryFolder;
export interface DocTableSelectionActions {
    selectedCount: number; selectedDocuments: Document[];
    automationDocument: Document | null; hasDocumentsInFolders: boolean;
    onAutomationDocumentChanged: () => Promise<void>;
    onDownload: () => Promise<void>; onRemoveFromFolder: () => Promise<void>;
    onDelete: () => Promise<void>;
}
const DOCUMENT_ROW_CLASS =
    "group flex h-11 min-h-11 w-full min-w-0 items-center border-b border-gray-100 pr-2 [content-visibility:auto] [contain-intrinsic-size:auto_44px]";
const DOCUMENT_METADATA_COLUMNS = [
    { label: "Type", row: "document-metadata ml-auto hidden w-20 shrink-0 sm:block",
        header: "document-metadata ml-auto hidden w-20 items-center gap-1 sm:flex", skeleton: "h-3 w-8 rounded bg-gray-100" },
    { label: "Size", row: "document-metadata hidden w-24 shrink-0 md:block",
        header: "document-metadata hidden w-24 items-center gap-1 md:flex", skeleton: "h-3 w-12 rounded bg-gray-100" },
    { label: "Version", row: "document-metadata w-20 shrink-0",
        header: "document-metadata flex w-20 items-center gap-1", skeleton: "h-3 w-5 rounded bg-gray-100" },
    { label: "Created", row: "document-metadata hidden w-32 shrink-0 lg:block",
        header: "document-metadata hidden w-32 items-center gap-1 lg:flex", skeleton: "h-3 w-16 rounded bg-gray-100" },
    { label: "Updated", row: "document-metadata hidden w-32 shrink-0 xl:block",
        header: "document-metadata hidden w-32 items-center gap-1 xl:flex", skeleton: "h-3 w-16 rounded bg-gray-100" },
] as const;
const DOCUMENT_METADATA_HEADERS = DOCUMENT_METADATA_COLUMNS.map(({ label, header }) =>
    <TableHeaderCell key={label} className={header}><span>{label}</span></TableHeaderCell>);
const FOLDER_METADATA_CELLS = DOCUMENT_METADATA_COLUMNS.map(
    ({ label, row }) => (
        <div
            key={label}
            className={`${row} ${label === "Type" ? "text-xs" : "text-sm"} text-gray-300`}
        >
            —
        </div>
    ),
);
const EMPTY_METADATA_VALUE = (
    <span className="text-gray-300">—</span>
);
const WARNING_KINDS = ["upload", "rename", "collection"] as const;
function prewarmDocumentView(doc: Document) {
    const type = (doc.file_type ?? doc.filename.split(".").pop() ?? "")
        .toLowerCase().replace(/^\./u, "");
    if (type === "pdf" || !!doc.pdf_storage_path) {
        void getPdfJs();
        void preloadSingleDoc(doc.id, doc.current_version_id, doc.updated_at)
            .catch(() => {});
    } else if (type === "doc" || type === "docx") {
        void preloadDocxViewer(
            doc.id,
            doc.current_version_id ?? undefined,
            doc.updated_at ?? undefined,
        ).catch(() => {});
    }
}
type InlineNameInputProps = {
    kind: "document" | "folder" | "new-folder";
    value?: string; onCommit: (value: string) => void; onCancel: () => void;
};
function InlineNameInput({ kind, value, onCommit, onCancel }: InlineNameInputProps) {
    const blockRow = kind !== "new-folder";
    return <input autoFocus defaultValue={value}
        className={kind === "folder"
            ? "flex-1 min-w-0 text-sm text-gray-800 bg-transparent outline-none"
            : "min-w-0 flex-1 text-sm text-gray-800 bg-transparent outline-none border-b border-gray-300"}
        placeholder={kind === "new-folder" ? "Folder name" : undefined}
        onClick={blockRow ? (event) => event.stopPropagation() : undefined}
        onDragStart={blockRow ? (event) => {
            event.preventDefault(); event.stopPropagation();
        } : undefined}
        onKeyDown={(event) => {
            if (event.key === "Enter") onCommit(event.currentTarget.value);
            if (event.key === "Escape") onCancel();
        }}
        onBlur={(event) => onCommit(event.currentTarget.value)} />;
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
        return <span title="Structural PDF parse in progress"
            className="ml-2 inline-flex shrink-0 items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
            <Loader2 className="h-3 w-3 animate-spin" />Parsing</span>;
    }
    if (state.status === "degraded") {
        return <span
            title={`Parsed with reduced structure${state.diagnostic_count ? ` — ${state.diagnostic_count} diagnostics` : ""}; flat text remains available`}
            className="ml-2 inline-flex shrink-0 items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
            Degraded</span>;
    }
    if (state.status === "failed") {
        return <span
            title={state.error ?? "Structural PDF parse failed; flat text remains available"}
            className="ml-2 inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">
            Parse failed
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
        Version: typeof version === "number" && version > 1 ? (
                <button type="button" onClick={onOpen}
                    onPointerEnter={() => prewarmDocumentView(doc)}
                    onFocus={() => prewarmDocumentView(doc)}
                    className={`flex h-8 min-w-8 items-center justify-center rounded-md px-2 ${APP_SURFACE_HOVER_CLASS}`}
                    title="Open version history"
                    aria-label={`Open version history for ${doc.filename}`}>{version}</button>
            ) : (
                <span className="pl-1 text-gray-300">—</span>
            ),
        Created: doc.created_at ? formatDate(doc.created_at) : EMPTY_METADATA_VALUE,
        Updated: doc.updated_at ? formatDate(doc.updated_at) : EMPTY_METADATA_VALUE,
    };
    return DOCUMENT_METADATA_COLUMNS.map(({ label, row }) => (
        <div key={label}
            className={`${row} ${label === "Type" ? "text-xs uppercase" : "text-sm"} ${label === "Version" ? "flex items-center gap-1" : "truncate"} text-gray-500`}
            onClick={label === "Version" ? (event) => event.stopPropagation() : undefined}>
            {values[label]}</div>
    ));
}
interface DocTableOperations {
    removeDocument?: (documentId: string) => Promise<void>; uploadDocument: (file: File) => Promise<Document>;
    refreshCollection: () => Promise<void>;
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
type PendingFolderDeletion = { folder: DocTableFolder; folderIds: string[];
    documentIds: string[]; documentCount: number; deleting: boolean };
type DocTableState = {
    addDocsOpen: boolean; viewingDoc: Document | null; viewingDocVersionId: string | null;
    selectedDocIds: string[];
    versionsByDocId: Map<string, { currentVersionId: string | null; versions: DocumentVersion[] }>;
    loadingVersionDocIds: Set<string>; renamingDocumentId: string | null;
    expandedFolderIds: Set<string>; newFolderParentId?: string | null;
    renamingFolderId: string | null; dragOverFolderId: string | null;
    dragOverSurface: "root" | `version:${string}` | null;
    uploadingVersionDocIds: Set<string>; uploadingDroppedFilenames: string[];
    deletingDocIds: Set<string>;
    warnings: Record<(typeof WARNING_KINDS)[number], string | null>;
    pendingDocumentRemoval: PendingDocumentRemoval | null;
    pendingDeleteFolder: PendingFolderDeletion | null;
};
const emphasis = (value: ReactNode) =>
    <span className="font-medium text-gray-950">{value}</span>;
const count = (total: number, one: string, many = `${one}s`) =>
    `${total} ${total === 1 ? one : many}`;
function without<T>(current: Set<T>, values: Iterable<T>) {
    const next = new Set(current);
    for (const value of values) next.delete(value);
    return next;
}
const scrollNewFolderIntoView = (element: HTMLDivElement | null) =>
    element?.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
function folderDeletionMessage(pending: PendingFolderDeletion | null) {
    if (!pending) return;
    const folders = pending.folderIds.length;
    return <div className="space-y-2"><p>
        This will permanently delete {emphasis(count(folders, "folder"))}, including{" "}
        {emphasis(pending.folder.name)}
        {folders > 1 ? " and its nested subfolders" : ""}.
    </p>{pending.documentCount > 0 && <p>
        {count(pending.documentCount, "document")} in the deleted{" "}
        {folders === 1 ? "folder" : "folders"} will also be permanently deleted.
    </p>}</div>;
}
interface DocTableProps {
    scopeKey: string; documents: Document[]; setDocuments: Dispatch<SetStateAction<Document[]>>;
    folders: DocTableFolder[]; setFolders: Dispatch<SetStateAction<DocTableFolder[]>>;
    loading: boolean; search: string; operations: DocTableOperations; emptyDropLabel?: string;
    renderAddDocumentsModal?: (open: boolean, onClose: () => void,
        onSelect: (documents: Document[]) => void) => ReactNode;
    onAddDocumentsActionChange?: (action: (() => void) | null) => void;
    onCreateFolderActionChange?: (action: (() => void) | null) => void;
    onSelectionActionsChange?: (actions: DocTableSelectionActions | null) => void;
    onOwnerOnlyAction?: Dispatch<SetStateAction<string | null>>;
    documentRemovalMode?: "delete" | "detach"; selectionFirst?: boolean;
    compact?: boolean;
}
const PROJECT_TABLE_LOADING = (
    <div className="flex-1 flex flex-col min-h-0">
        {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className={DOCUMENT_ROW_CLASS}>
                <div className={`${DOC_NAME_COL_W} py-2 pl-4 pr-2`}>
                    <div className="flex items-center">
                        <TableSelectionPlaceholder />
                        <div className="mr-2 h-4 w-4 shrink-0 rounded bg-gray-100" />
                        <div className="h-3.5 rounded bg-gray-100"
                            style={{ width: `${210 + i * 16}px` }} />
                    </div>
                </div>
                {DOCUMENT_METADATA_COLUMNS.map(({ label, row, skeleton }) =>
                    <div key={label} className={row}><div className={skeleton} /></div>)}
                <div className="w-8 shrink-0" />
            </div>
        ))}
    </div>
);
export function DocTable({
    scopeKey, documents, setDocuments, folders, setFolders, loading, search, operations,
    emptyDropLabel = "Drop PDF, Word, Excel, or PowerPoint files here",
    renderAddDocumentsModal, onAddDocumentsActionChange,
    onCreateFolderActionChange, onSelectionActionsChange, onOwnerOnlyAction,
    documentRemovalMode = "delete", selectionFirst = false, compact = false,
}: DocTableProps) {
    const { user } = useAuth();
    const [state, setState] = useState<DocTableState>(() => ({
        addDocsOpen: false, viewingDoc: null, viewingDocVersionId: null,
        selectedDocIds: [], versionsByDocId: new Map(), loadingVersionDocIds: new Set(),
        renamingDocumentId: null, expandedFolderIds: new Set(), renamingFolderId: null,
        dragOverFolderId: null, dragOverSurface: null, uploadingVersionDocIds: new Set(),
        uploadingDroppedFilenames: [], deletingDocIds: new Set(),
        warnings: { upload: null, rename: null, collection: null },
        pendingDocumentRemoval: null,
        pendingDeleteFolder: null,
    }));
    function set<K extends keyof DocTableState>(key: K,
        next: DocTableState[K] | ((current: DocTableState[K]) => DocTableState[K])) {
        setState((current) => {
            const value = typeof next === "function"
                ? (next as (value: DocTableState[K]) => DocTableState[K])(current[key])
                : next;
            return Object.is(value, current[key]) ? current : { ...current, [key]: value };
        });
    }
    const {
        addDocsOpen, viewingDoc, viewingDocVersionId, selectedDocIds, versionsByDocId,
        loadingVersionDocIds, renamingDocumentId, expandedFolderIds, newFolderParentId,
        renamingFolderId, dragOverFolderId, dragOverSurface, uploadingVersionDocIds,
        uploadingDroppedFilenames, deletingDocIds, warnings,
        pendingDocumentRemoval, pendingDeleteFolder,
    } = state;
    const documentUploadInputRef = useRef<HTMLInputElement>(null);
    const loadingRef = useRef(loading);
    const renderAddDocumentsModalRef = useRef(renderAddDocumentsModal);
    const detachesDocument = documentRemovalMode === "detach";
    const removeDocument = operations.removeDocument ?? deleteDocument;
    const refreshCollection = operations.refreshCollection;
    useEffect(() => {
        loadingRef.current = loading;
        renderAddDocumentsModalRef.current = renderAddDocumentsModal;
    }, [loading, renderAddDocumentsModal]);
    useEffect(() => {
        void getPdfJs().catch(() => {});
    }, []);
    const openAddDocuments = useCallback(() => {
        if (loadingRef.current) return;
        if (renderAddDocumentsModalRef.current) {
            set("addDocsOpen", true);
            return;
        }
        documentUploadInputRef.current?.click();
    }, []);
    const loadDocumentVersions = async (docId: string) => {
        if (versionsByDocId.has(docId)) return;
        set("loadingVersionDocIds", (prev) => new Set(prev).add(docId));
        try {
            const res = await listDocumentVersions(docId);
            set("versionsByDocId", (prev) => new Map(prev).set(docId, {
                currentVersionId: res.current_version_id, versions: res.versions,
            }));
        } catch (e) {
            console.error("listDocumentVersions failed", e);
        } finally {
            set("loadingVersionDocIds", (prev) => without(prev, [docId]));
        }
    };
    async function downloadDocVersion(docId: string, versionId: string, filename: string) {
        try {
            const resolved = await getDocumentUrl(docId, versionId);
            downloadUrl(resolved.url, resolved.filename || filename);
        } catch (e) {
            console.error("downloadDocVersion failed", e);
        }
    }
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
    async function submitNewVersion(doc: Document, file: File, filename: string) {
        try {
            await uploadDocumentVersion(doc.id, file, filename);
            await refreshDocumentVersionState(doc.id);
        } catch (e) {
            console.error("uploadDocumentVersion failed", e);
        }
    }
    async function replaceVersionFile(docId: string, versionId: string,
        file: File, filename: string) {
        await replaceDocumentVersionFile(docId, versionId, file, filename);
        const res = await refreshDocumentVersionState(docId);
        if (res.versions.some((version) => version.id === versionId))
            set("viewingDocVersionId", versionId);
    }
    const refreshDocumentVersionState = useCallback(async (docId: string) => {
        await refreshCollection();
        const res = await listDocumentVersions(docId);
        set("versionsByDocId", (prev) => new Map(prev).set(docId, {
            currentVersionId: res.current_version_id, versions: res.versions,
        }));
        return res;
    }, [refreshCollection]);
    async function handleRenameVersion(docId: string, versionId: string,
        filename: string | null) {
        const previousFilename = versionsByDocId.get(docId)?.versions
            .find((version) => version.id === versionId)?.filename?.trim();
        if (previousFilename && (filename == null ||
            hasFilenameExtensionChange(previousFilename, filename))) {
            setWarning("rename", filenameExtensionChangeWarning(previousFilename));
            return;
        }
        try {
            const updated = await renameDocumentVersion(docId, versionId, filename);
            set("versionsByDocId", (prev) => {
                const cached = prev.get(docId);
                if (!cached) return prev;
                return new Map(prev).set(docId, {
                    ...cached,
                    versions: cached.versions.map((v) => v.id === versionId ? updated : v),
                });
            });
        } catch (e) {
            console.error("renameDocumentVersion failed", e);
        }
    }
    async function handleDeleteVersion(docId: string, versionId: string) {
        try {
            await deleteDocumentVersion(docId, versionId);
            const res = await refreshDocumentVersionState(docId);
            const activeVersions = res.versions.filter((version) => version.deleted_at == null);
            const nextVersion =
                activeVersions.find((version) => version.id === res.current_version_id) ??
                activeVersions[activeVersions.length - 1] ?? null;
            set("viewingDocVersionId", nextVersion?.id ?? null);
        } catch (e) {
            console.error("deleteDocumentVersion failed", e);
            setWarning("rename", "Could not delete this version.");
        }
    }
    const versionUploadInputRef = useRef<HTMLInputElement>(null);
    const versionUploadTargetDocRef = useRef<Document | null>(null);
    function setWarning(kind: (typeof WARNING_KINDS)[number], message: string | null) {
        set("warnings", (current) =>
            current[kind] === message ? current : { ...current, [kind]: message },
        );
    }
    const openCreateFolder = useCallback(() => {
        if (loadingRef.current) return;
        set("newFolderParentId", null);
    }, []);
    useEffect(() => {
        onAddDocumentsActionChange?.(openAddDocuments);
        onCreateFolderActionChange?.(openCreateFolder);
        return () => {
            onAddDocumentsActionChange?.(null);
            onCreateFolderActionChange?.(null);
            onSelectionActionsChange?.(null);
        };
    }, [onAddDocumentsActionChange, onCreateFolderActionChange,
        onSelectionActionsChange, openAddDocuments, openCreateFolder]);
    useEffect(() => {
        if (loading) return;
        const ids = folders.map((folder) => folder.id);
        set("expandedFolderIds", (current) =>
            current.size === ids.length && ids.every((id) => current.has(id))
                ? current
                : new Set(ids),
        );
    }, [loading, folders]);
    useEffect(() => {
        set("selectedDocIds", (current) => (current.length ? [] : current));
    }, [scopeKey]);
    const tree = buildDocumentTree(
        documents, folders, expandedFolderIds, newFolderParentId, search);
    const filteredDocs = tree.visibleDocuments;
    const docsById = useMemo(() =>
        new Map(documents.map((doc) => [doc.id, doc])), [documents]);
    const foldersById = tree.folderById;
    const foldersByParent = tree.foldersByParent;
    const selectedIdSet = new Set(selectedDocIds);
    function patchDocument(id: string, patch: Partial<Document>) {
        setDocuments((prev) => prev.map((doc) =>
            doc.id === id ? { ...doc, ...patch } : doc));
    }
    function patchFolder(id: string, patch: Partial<DocTableFolder>) {
        setFolders((prev) => prev.map((folder) =>
            folder.id === id ? { ...folder, ...patch } : folder));
    }
    function toggleFolder(id: string) {
        set("expandedFolderIds", (prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }
    async function handleCreateFolder(parentId: string | null, value: string) {
        const name = value.trim();
        if (!name) return set("newFolderParentId", undefined);
        set("newFolderParentId", undefined);
        const tempId = `temp-${Date.now()}`;
        const now = new Date().toISOString();
        const optimistic = {
            id: tempId, user_id: "", name, parent_folder_id: parentId,
            created_at: now, updated_at: now,
        } as DocTableFolder;
        setFolders((prev) => [...prev, optimistic]);
        set("expandedFolderIds", (prev) =>
            new Set([...prev, tempId, ...(parentId ? [parentId] : [])]));
        const folder = await operations.createFolder(name, parentId ?? null);
        setFolders((prev) => prev.map((f) => (f.id === tempId ? folder : f)));
        set("expandedFolderIds", (prev) => {
            const next = new Set(prev);
            next.delete(tempId);
            next.add(folder.id);
            return next;
        });
    }
    async function handleRenameFolder(folderId: string, value: string) {
        const name = value.trim();
        set("renamingFolderId", null);
        if (!name) return;
        patchFolder(folderId, { name });
        await operations.renameFolder(folderId, name);
    }
    function folderDeleteImpact(folderId: string) {
        const toDelete = descendantFolderIds(folderId, foldersByParent);
        const folderIds = [...toDelete];
        const documentIds = documents
            .filter((d) => d.folder_id && toDelete.has(d.folder_id))
            .map((d) => d.id);
        return { folderIds, documentIds, documentCount: documentIds.length };
    }
    function requestDeleteFolder(folderId: string) {
        const folder = foldersById.get(folderId);
        if (!folder) return;
        set("pendingDeleteFolder",
            { folder, ...folderDeleteImpact(folderId), deleting: false });
    }
    async function confirmDeletePendingFolder() {
        const pending = pendingDeleteFolder;
        if (!pending || pending.deleting) return;
        set("pendingDeleteFolder", (current) =>
            current ? { ...current, deleting: true } : current);
        try {
            await operations.deleteFolder(pending.folder.id);
            const toDelete = new Set(pending.folderIds);
            setFolders((prev) => prev.filter((f) => !toDelete.has(f.id)));
            setDocuments((prev) => prev.filter((d) =>
                !d.folder_id || !toDelete.has(d.folder_id)));
            set("expandedFolderIds", (prev) => without(prev, toDelete));
            if (renamingFolderId && toDelete.has(renamingFolderId))
                set("renamingFolderId", null);
            const deletedDocIds = new Set(pending.documentIds);
            set("selectedDocIds", (prev) =>
                prev.filter((id) => !deletedDocIds.has(id)));
            set("versionsByDocId", (prev) => {
                const next = new Map(prev);
                for (const id of pending.documentIds) next.delete(id);
                return next;
            });
            set("pendingDeleteFolder", null);
        } catch (err) {
            console.error("delete folder failed", err);
            set("pendingDeleteFolder", (current) =>
                current ? { ...current, deleting: false } : current);
            setWarning("collection", "Folder could not be deleted. Please try again.");
        }
    }
    function handleDocsSelected(newDocs: Document[]) {
        setDocuments((prev) => [...prev,
            ...newDocs.filter((d) => !prev.some((e) => e.id === d.id))]);
    }
    async function handleRemoveDocFromFolder(docId: string) {
        patchDocument(docId, { folder_id: null });
        await operations.moveDocument(docId, null);
    }
    async function retryParse(docId: string) {
        if (!operations.retryPdfParse) return;
        patchDocument(docId, {
            parse_state: {
                ...(docsById.get(docId)?.parse_state ?? null),
                status: "queued",
                error: null,
            } as Document["parse_state"],
        });
        try {
            await operations.retryPdfParse(docId);
        } finally {
            await operations.refreshCollection();
        }
    }
    async function submitDocumentRename(docId: string, value: string) {
        const trimmed = value.trim();
        if (!trimmed) return set("renamingDocumentId", null);
        const previous = docsById.get(docId);
        if (!previous || trimmed === previous.filename)
            return set("renamingDocumentId", null);
        if (hasFilenameExtensionChange(previous.filename, trimmed)) {
            setWarning("rename", filenameExtensionChangeWarning(previous.filename));
            return;
        }
        set("renamingDocumentId", null);
        patchDocument(docId,
            { filename: trimmed, updated_at: new Date().toISOString() });
        try {
            const updated = await operations.renameDocument(docId, trimmed);
            patchDocument(docId, updated);
        } catch (e) {
            console.error("renameDocument failed", e);
            setDocuments((prev) => previous
                ? prev.map((d) => d.id === docId ? previous : d) : prev);
        }
    }
    async function handleRemoveDocuments(
        documentIds: string[],
        fromSelection: boolean,
    ) {
        const owned = documentIds.filter((id) => {
            const doc = docsById.get(id);
            return !doc || !doc.user_id || !user?.id || doc.user_id === user.id;
        });
        const blocked = documentIds.length - owned.length;
        if (!fromSelection && blocked) {
            onOwnerOnlyAction?.(
                detachesDocument
                    ? "remove this document from the project"
                    : "delete this document",
            );
            return;
        }
        if (fromSelection) {
            set("selectedDocIds", []);
        } else {
            set("deletingDocIds", (prev) => new Set([...prev, ...owned]));
        }
        try {
            const results = await Promise.allSettled(
                owned.map((id) => removeDocument(id)),
            );
            const removedIds = new Set(
                owned.filter(
                    (_, index) => results[index].status === "fulfilled",
                ),
            );
            if (removedIds.size) {
                setDocuments((prev) =>
                    prev.filter((doc) => !removedIds.has(doc.id)),
                );
            }
            if (fromSelection && removedIds.size) {
                set("versionsByDocId", (prev) => {
                    const next = new Map(prev);
                    for (const id of removedIds) next.delete(id);
                    return next;
                });
            }
            if (!fromSelection) {
                const failure = results.find(
                    (result): result is PromiseRejectedResult =>
                        result.status === "rejected",
                );
                if (failure) throw failure.reason;
                return;
            }
            const failed = owned.length - removedIds.size;
            if (failed) {
                setWarning(
                    "collection",
                    `${failed} ${failed === 1 ? "document" : "documents"} could not be ${
                        detachesDocument
                            ? "removed from this project"
                            : "deleted"
                    }. Please try again.`,
                );
            }
            if (blocked) {
                onOwnerOnlyAction?.(
                    detachesDocument
                        ? `remove ${blocked} of the selected documents \u2014 only the document creator can remove a document from this project`
                        : `delete ${blocked} of the selected documents \u2014 only the document creator can delete a document`,
                );
            }
        } finally {
            if (!fromSelection) {
                set("deletingDocIds", (prev) => without(prev, owned));
            }
        }
    }
    function requestRemoveDoc(doc: Document) {
        if (doc && user?.id && doc.user_id && doc.user_id !== user.id) {
            onOwnerOnlyAction?.(
                detachesDocument
                    ? "remove this document from the project"
                    : "delete this document",
            );
            return;
        }
        set("pendingDocumentRemoval", {
            documents: [doc],
            fromSelection: false,
            deleting: false,
        });
    }
    function hasMovePayload(dt: DataTransfer): boolean {
        return hasDocumentTreeDrag(dt);
    }
    function hasFilePayload(dt: DataTransfer): boolean {
        return dt.types.includes("Files");
    }
    function clearDragOver() {
        set("dragOverFolderId", null);
        set("dragOverSurface", null);
    }
    function isSharedDocument(doc: Document | null | undefined): boolean {
        return !!(doc?.user_id && user?.id && doc.user_id !== user.id);
    }
    function acceptedFiles(files: File[]) {
        if (!files.length) return [];
        const { supported, unsupported } =
            partitionSupportedDocumentFiles(files);
        setWarning("upload", formatUnsupportedDocumentWarning(unsupported));
        return supported;
    }
    async function handleDropCollectionFiles(files: File[]) {
        const supported = acceptedFiles(files);
        if (supported.length === 0) return;
        set("uploadingDroppedFilenames", supported.map((file) => file.name));
        try {
            const uploaded = await Promise.all(
                supported.map((file) => operations.uploadDocument(file)),
            );
            handleDocsSelected(uploaded);
        } catch (err) {
            console.error("Document drop upload failed", err);
        } finally {
            set("uploadingDroppedFilenames", []);
        }
    }
    async function handleDropDocumentVersions(doc: Document, files: File[]) {
        const supported = acceptedFiles(files);
        if (supported.length === 0) return;
        set("uploadingVersionDocIds", (prev) => new Set(prev).add(doc.id));
        try {
            for (const file of supported) {
                await uploadDocumentVersion(doc.id, file, file.name);
            }
            await refreshDocumentVersionState(doc.id);
        } catch (err) {
            console.error("Document version drop upload failed", err);
        } finally {
            set("uploadingVersionDocIds", (prev) => without(prev, [doc.id]));
        }
    }
    function handleDocumentVersionDragOver(
        e: DragEvent<HTMLDivElement>,
        docId: string,
    ) {
        if (!hasFilePayload(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        set("dragOverSurface", `version:${docId}`);
    }
    function handleDocumentVersionDragLeave(e: DragEvent<HTMLDivElement>) {
        if (!e.currentTarget.contains(e.relatedTarget as Node) && dragOverSurface?.startsWith("version:"))
            set("dragOverSurface", null);
    }
    function handleDocumentVersionDrop(e: DragEvent<HTMLDivElement>, doc: Document) {
        if (!hasFilePayload(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        clearDragOver();
        void handleDropDocumentVersions(doc, Array.from(e.dataTransfer.files));
    }
    async function handleDropOnFolder(targetFolderId: string | null, dt: DataTransfer) {
        if (!hasMovePayload(dt)) return;
        const docId = dt.getData(DOCUMENT_DRAG_TYPE);
        const subFolderId = dt.getData(FOLDER_DRAG_TYPE);
        if (docId) {
            const doc = docsById.get(docId);
            if (!doc || (doc.folder_id ?? null) === targetFolderId) return;
            patchDocument(docId, { folder_id: targetFolderId });
            await operations.moveDocument(docId, targetFolderId);
        } else if (subFolderId && subFolderId !== targetFolderId) {
            if (targetFolderId !== null &&
                wouldCreateFolderCycle(subFolderId, targetFolderId, foldersById))
                return;
            const folder = foldersById.get(subFolderId);
            if (!folder || (folder.parent_folder_id ?? null) === targetFolderId)
                return;
            patchFolder(subFolderId, { parent_folder_id: targetFolderId });
            await operations.moveFolder(subFolderId, targetFolderId);
        }
    }
    function renderDocumentActivityRow({ key, filename, fileType, depth, statusLabel }: {
        key: string; filename: string; fileType: string | null;
        depth: number; statusLabel: string;
    }) {
        return (
            <div key={key} className={DOCUMENT_ROW_CLASS}>
                <div className={`${DOC_NAME_COL_W} py-2 pl-4 pr-2`}
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
        set("viewingDocVersionId", null);
        set("viewingDoc", doc);
    }
    function toggleDocumentSelection(docId: string) {
        set("selectedDocIds", (prev) =>
            prev.includes(docId)
                ? prev.filter((id) => id !== docId)
                : [...prev, docId],
        );
    }
    function selectAndOpen(doc: Document) {
        set("selectedDocIds", [doc.id]);
        openDocument(doc);
    }
    function handleDocumentRowClick(doc: Document) {
        if (selectionFirst) set("selectedDocIds", [doc.id]);
        else openDocument(doc);
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
            toggleDocumentSelection(doc.id);
        }
    }
    function handleDocumentDragStart(event: DragEvent<HTMLDivElement>, doc: Document) {
        if (renamingDocumentId === doc.id) return event.preventDefault();
        event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, doc.id);
        event.dataTransfer.effectAllowed = "copyMove";
    }
    function handleFolderDragStart(event: DragEvent<HTMLDivElement>, folderId: string) {
        if (renamingFolderId === folderId) return event.preventDefault();
        event.dataTransfer.setData(FOLDER_DRAG_TYPE, folderId);
        event.dataTransfer.effectAllowed = "move";
        event.stopPropagation();
    }
    function handleCollectionDragOver(event: DragEvent<HTMLDivElement>) {
        if (hasFilePayload(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        } else if (hasMovePayload(event.dataTransfer)) {
            event.preventDefault();
            const folderId = documentTreeDropFolder(event.target);
            set("dragOverFolderId", folderId);
            set("dragOverSurface", folderId ? null : "root");
        }
    }
    function handleCollectionDragLeave(event: DragEvent<HTMLDivElement>) {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
            clearDragOver();
    }
    async function handleCollectionDrop(event: DragEvent<HTMLDivElement>) {
        if (hasFilePayload(event.dataTransfer)) {
            event.preventDefault();
            void handleDropCollectionFiles(Array.from(event.dataTransfer.files));
        } else if (hasMovePayload(event.dataTransfer)) {
            event.preventDefault();
            const folderId = documentTreeDropFolder(event.target);
            clearDragOver();
            await handleDropOnFolder(folderId, event.dataTransfer);
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
                    if (row.kind === "editor") return (
                        <div ref={scrollNewFolderIntoView}
                            key={`new-folder-${row.parentId ?? "root"}`}
                            data-tree-drop-folder={row.parentId ?? ""}
                            className={DOCUMENT_ROW_CLASS}>
                            <div className={`${DOC_NAME_COL_W} py-2 pl-4 pr-2`}
                                style={treeNameCellStyle(row.depth)}>
                                <div className="flex items-center">
                                    <span className="mr-4 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                                        <ChevronRight className="h-3.5 w-3.5 text-gray-300" />
                                    </span>
                                    <FolderSvgIcon className="mr-2 h-4 w-4 shrink-0" />
                                    <InlineNameInput kind="new-folder"
                                        onCommit={(name) =>
                                            void handleCreateFolder(row.parentId, name)}
                                        onCancel={() => set("newFolderParentId", undefined)} />
                                </div>
                            </div>
                            {DOCUMENT_METADATA_COLUMNS.map(({ label, row: column }) =>
                                <div key={label} className={column} />)}
                            <div className="w-8 shrink-0" />
                        </div>
                    );
                    if (row.kind === "folder") {
                        const folder = row.folder;
                        const isExpanded = expandedFolderIds.has(folder.id);
                        const isRenaming = renamingFolderId === folder.id;
                        const isDragOver = dragOverFolderId === folder.id;
                        return (
                            <div key={`folder-${folder.id}`}
                                data-tree-drop-folder={folder.id}
                                draggable={!isRenaming}
                                onDragStart={(event) => handleFolderDragStart(event, folder.id)}
                                onClick={() => toggleFolder(folder.id)}
                                className={`${DOCUMENT_ROW_CLASS} cursor-pointer ${isRenaming ? "" : "select-none"} ${isDragOver ? "bg-red-50 ring-1 ring-inset ring-red-200" : `bg-app-surface ${APP_SURFACE_HOVER_CLASS}`}`}>
                                <div className={`${DOC_NAME_COL_W} py-2 pl-4 pr-2`}
                                    style={treeNameCellStyle(row.depth)}>
                                    <div className="flex items-center">
                                        <span className="mr-4 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                                            {isExpanded
                                                ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                                                : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
                                        </span>
                                        <FolderSvgIcon open={isExpanded}
                                            className="mr-2 h-4 w-4 shrink-0" />
                                        {isRenaming ? <InlineNameInput kind="folder"
                                                value={folder.name}
                                                onCommit={(value) =>
                                                    void handleRenameFolder(folder.id, value)}
                                                onCancel={() => set("renamingFolderId", null)} /> : (
                                            <span className="truncate text-sm text-gray-800">
                                                {folder.name}</span>
                                        )}
                                    </div>
                                </div>
                                {FOLDER_METADATA_CELLS}
                                <div className="flex w-8 shrink-0 justify-end"
                                    onClick={(event) => event.stopPropagation()}>
                                    <RowActions
                                        onNewSubfolder={() => {
                                            set("newFolderParentId", folder.id);
                                            set("expandedFolderIds", (current) =>
                                                new Set(current).add(folder.id));
                                        }}
                                        newSubfolderLabel="New subfolder inside"
                                        onRename={() => set("renamingFolderId", folder.id)}
                                        onDelete={() => requestDeleteFolder(folder.id)} />
                                </div>
                            </div>
                        );
                    }
                    const doc = row.document;
                    const docName = doc.filename;
                    const isProcessing = doc.status === "pending" || doc.status === "processing";
                    const isError = doc.status === "error";
                    const isVersionDragOver = dragOverSurface === `version:${doc.id}`;
                    const isUploadingVersion = uploadingVersionDocIds.has(doc.id);
                    const prewarm = () => prewarmDocumentView(doc);
                    const isSelected = selectedIdSet.has(doc.id);
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
                            onClick={() => handleDocumentRowClick(doc)}
                            onDoubleClick={(event) => handleDocumentRowDoubleClick(event, doc)}
                            onKeyDown={(event) => handleDocumentRowKeyDown(event, doc)}
                            tabIndex={selectionFirst ? 0 : undefined}
                            role={selectionFirst ? "row" : undefined}
                            aria-selected={selectionFirst ? isSelected : undefined}
                            className={`${DOCUMENT_ROW_CLASS} cursor-pointer ${selectionFirst ? "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600" : ""} ${isVersionDragOver ? "bg-red-50 ring-1 ring-inset ring-red-200" : isSelected ? APP_SURFACE_ACTIVE_CLASS : `bg-app-surface ${APP_SURFACE_HOVER_CLASS}`}`}>
                            <div className={`${DOC_NAME_COL_W} py-2 pl-4 pr-2`}
                                style={treeNameCellStyle(row.depth)}>
                                <div className="flex items-center">
                                    {isProcessing || isUploadingVersion ? (
                                        <span className="-ml-2 mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center">
                                            <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                                        </span>
                                    ) : (
                                        <CheckboxControl checked={isSelected}
                                            onChange={() => toggleDocumentSelection(doc.id)}
                                            onClick={(event) => event.stopPropagation()}
                                            className="-ml-2 mr-1" />
                                    )}
                                    <span className="mr-2 shrink-0">
                                        {isError
                                            ? <AlertCircle className="h-4 w-4 text-red-500" />
                                            : <FileTypeIcon fileType={doc.file_type}
                                                className="h-4 w-4" />}
                                    </span>
                                    {renamingDocumentId === doc.id ? <InlineNameInput kind="document"
                                            value={docName}
                                            onCommit={(value) =>
                                                void submitDocumentRename(doc.id, value)}
                                            onCancel={() => set("renamingDocumentId", null)} /> : (
                                        <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                                            {docName}</span>
                                    )}
                                    <ParseStateChip doc={doc}
                                        onRetry={operations.retryPdfParse
                                            ? () => void retryParse(doc.id)
                                            : undefined} />
                                    {selectionFirst && (
                                        <button type="button"
                                            aria-label={`View ${docName}`}
                                            title={`View ${docName}`}
                                            disabled={renamingDocumentId === doc.id}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                selectAndOpen(doc);
                                            }}
                                            onPointerEnter={prewarm}
                                            onFocus={prewarm}
                                            className={pillButtonClassName("black", "sm",
                                                "ml-2 h-8 min-w-14 shrink-0 px-3 disabled:invisible")}>
                                            View</button>
                                    )}
                                </div>
                            </div>
                            <DocumentMetadataCells doc={doc}
                                onOpen={() => openDocument(doc)} />
                            <div className="flex w-8 shrink-0 justify-end">
                                {!isProcessing && (
                                    <RowActions
                                        onRename={() => set("renamingDocumentId", doc.id)}
                                        renameLabel="Rename document"
                                        onDownload={() => downloadDoc(doc.id)}
                                        onUploadNewVersion={() => void handleUploadNewVersion(doc)}
                                        onRemoveFromFolder={doc.folder_id
                                            ? () => handleRemoveDocFromFolder(doc.id) : undefined}
                                        onDelete={() => requestRemoveDoc(doc)}
                                        deleteLabel={detachesDocument
                                            ? "Remove from project" : "Delete"}
                                        deleteDisabled={isSharedDocument(doc)} />
                                )}
                            </div>
                        </div>
                    );
                })}
            </>
        );
    }
    const downloadDoc = useCallback(async (docId: string) => {
        const { url, filename } = await getDocumentUrl(docId);
        downloadUrl(url, filename);
    }, []);
    const handleDownloadSelectedDocs = useCallback(async () => {
        if (selectedDocIds.length === 1) {
            await downloadDoc(selectedDocIds[0]);
            return;
        }
        downloadBlob(await downloadDocumentsZip(selectedDocIds), "documents.zip");
    }, [downloadDoc, selectedDocIds]);
    const handleRemoveSelectedFromFolder = useCallback(async () => {
        const ids = new Set(
            selectedDocIds.filter((id) => docsById.get(id)?.folder_id != null),
        );
        if (ids.size === 0) return;
        setDocuments((prev) => prev.map((d) =>
            ids.has(d.id) ? { ...d, folder_id: null } : d));
        await Promise.all([...ids].map((id) =>
            operations.moveDocument(id, null).catch(() => {})));
    }, [docsById, operations, selectedDocIds, setDocuments]);
    const requestDeleteSelectedDocs = useCallback(async () => {
        const documentsToRemove = selectedDocIds
            .map((id) => docsById.get(id))
            .filter((document): document is Document => !!document);
        if (!documentsToRemove.length) return;
        set("pendingDocumentRemoval",
            { documents: documentsToRemove, fromSelection: true, deleting: false });
    }, [docsById, selectedDocIds]);
    async function confirmPendingDocumentRemoval() {
        const pending = pendingDocumentRemoval;
        if (!pending || pending.deleting) return;
        set("pendingDocumentRemoval", (current) =>
            current ? { ...current, deleting: true } : current);
        try {
            await handleRemoveDocuments(
                pending.documents.map((document) => document.id), pending.fromSelection);
            set("pendingDocumentRemoval", null);
        } catch (err) {
            if (pending.fromSelection) throw err;
            console.error("delete document failed", err);
            set("pendingDocumentRemoval", (current) =>
                current ? { ...current, deleting: false } : current);
            setWarning(
                "collection",
                detachesDocument
                    ? "The document could not be removed from this project. Please try again."
                    : "The document could not be deleted. Please try again.",
            );
        }
    }
    const sidePanelDoc = viewingDoc ? docsById.get(viewingDoc.id) ?? viewingDoc : null;
    const allDocsSelected = filteredDocs.length > 0 &&
        filteredDocs.every((doc) => selectedIdSet.has(doc.id));
    const someDocsSelected = !allDocsSelected &&
        filteredDocs.some((doc) => selectedIdSet.has(doc.id));
    const selectedAutomationDocument =
        scopeKey !== "templates" && selectedDocIds.length === 1
            ? (docsById.get(selectedDocIds[0]) ?? null)
            : null;
    const selectionActions = useMemo<DocTableSelectionActions | null>(() => {
        if (selectedDocIds.length === 0) return null;
        return {
            selectedCount: selectedDocIds.length,
            selectedDocuments: selectedDocIds
                .map((id) => docsById.get(id))
                .filter((document): document is Document => !!document),
            automationDocument: selectedAutomationDocument,
            hasDocumentsInFolders: selectedDocIds.some(
                (id) => docsById.get(id)?.folder_id != null),
            onAutomationDocumentChanged: async () => {
                if (!selectedAutomationDocument) return;
                await refreshDocumentVersionState(selectedAutomationDocument.id);
            },
            onDownload: handleDownloadSelectedDocs,
            onRemoveFromFolder: handleRemoveSelectedFromFolder,
            onDelete: requestDeleteSelectedDocs,
        };
    }, [docsById, handleDownloadSelectedDocs, handleRemoveSelectedFromFolder,
        refreshDocumentVersionState, requestDeleteSelectedDocs,
        selectedAutomationDocument, selectedDocIds]);
    useEffect(() => {
        onSelectionActionsChange?.(selectionActions);
    }, [onSelectionActionsChange, selectionActions]);
    const pendingDeleteDoc =
        pendingDocumentRemoval && !pendingDocumentRemoval.fromSelection
            ? pendingDocumentRemoval.documents[0]
            : null;
    const pendingDeleteDocVersionCount = pendingDeleteDoc
        ? versionsByDocId
              .get(pendingDeleteDoc.id)
              ?.versions.filter((version) => version.deleted_at == null).length
        : undefined;
    const pendingDeleteMessage = documentRemovalMessage(
        pendingDocumentRemoval,
        detachesDocument,
        pendingDeleteDocVersionCount,
    );
    const pendingDeleteFolderMessage = folderDeletionMessage(pendingDeleteFolder);
    return (
        <div className={`relative flex h-full min-h-0 flex-1 flex-col overflow-hidden ${compact ? "[&_.document-metadata]:hidden" : ""}`}
            onDragEnd={clearDragOver}>
            <input ref={versionUploadInputRef} type="file"
                accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt"
                className="hidden" onChange={handleVersionUploadInputChange} />
            <input ref={documentUploadInputRef} type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT} multiple className="hidden"
                onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    void handleDropCollectionFiles(files);
                }} />
            {WARNING_KINDS.map((kind) => (
                <WarningPopup key={kind} open={!!warnings[kind]}
                    onClose={() => setWarning(kind, null)}
                    message={warnings[kind]} />
            ))}
            <ConfirmPopup open={!!pendingDocumentRemoval}
                title={
                    detachesDocument
                        ? "Remove from project?"
                        : pendingDocumentRemoval?.fromSelection
                          ? "Delete documents?"
                          : "Delete document?"
                }
                message={pendingDeleteMessage}
                confirmLabel={detachesDocument ? "Remove" : "Delete"}
                confirmStatus={pendingDocumentRemoval?.deleting ? "loading" : "idle"}
                cancelLabel="Cancel"
                onCancel={() => {
                    if (pendingDocumentRemoval?.deleting) return;
                    set("pendingDocumentRemoval", null);
                }}
                onConfirm={() => void confirmPendingDocumentRemoval()} />
            <ConfirmPopup open={!!pendingDeleteFolder} title="Delete folder?"
                message={pendingDeleteFolderMessage} confirmLabel="Delete"
                confirmStatus={pendingDeleteFolder?.deleting ? "loading" : "idle"}
                cancelLabel="Cancel"
                onCancel={() => {
                    if (pendingDeleteFolder?.deleting) return;
                    set("pendingDeleteFolder", null);
                }}
                onConfirm={() => void confirmDeletePendingFolder()} />
            <TableScrollArea className="document-table"
                header={
                    <TableHeaderRow className="!min-w-0 w-full pr-2">
                        <TableStickyCell header widthClassName={DOC_NAME_COL_W}>
                            <CheckboxControl checked={allDocsSelected}
                                ref={(el) => {
                                    if (el) el.indeterminate = someDocsSelected;
                                }}
                                onChange={() =>
                                    set("selectedDocIds",
                                        allDocsSelected ? [] : filteredDocs.map((d) => d.id),
                                    )
                                }
                                className="-ml-2 mr-1" />
                            <span aria-hidden="true"
                                className="mr-2 h-4 w-4 shrink-0" />
                            <span className="mr-1">Name</span>
                        </TableStickyCell>
                        {DOCUMENT_METADATA_HEADERS}
                        <TableHeaderCell className="w-8" />
                    </TableHeaderRow>
                }
            >
                    {loading ? PROJECT_TABLE_LOADING : (
                        <div className="flex-1 flex flex-col min-h-0">
                            <div className="flex-1 flex flex-col min-h-0 relative">
                                {dragOverSurface === "root" && dragOverFolderId === null && (
                                    <div className="pointer-events-none absolute inset-0 z-[80] border-2 border-red-400" />
                                )}
                                {documents.length === 0 &&
                                folders.length === 0 &&
                                uploadingDroppedFilenames.length === 0 ? (
                                    <div onClick={openAddDocuments}
                                        onDragOver={handleCollectionDragOver}
                                        onDragLeave={handleCollectionDragLeave}
                                        onDrop={(event) => void handleCollectionDrop(event)}
                                        className="flex-1 flex cursor-pointer flex-col items-center justify-center py-24 text-center">
                                        <FolderSvgIcon className="mb-3 h-8 w-8 text-gray-700" />
                                        <p className="text-sm text-gray-400">{emptyDropLabel}</p>
                                    </div>
                                ) : (
                                    <div className="flex-1 flex flex-col"
                                        onDragOver={handleCollectionDragOver}
                                        onDragLeave={handleCollectionDragLeave}
                                        onDrop={(event) => void handleCollectionDrop(event)}>
                                        {renderRows()}
                                        <div className="flex-1 min-h-16" />
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
            </TableScrollArea>
            {renderAddDocumentsModal?.(addDocsOpen,
                () => set("addDocsOpen", false), handleDocsSelected)}
            <DocumentSidePanel
                doc={sidePanelDoc}
                versionId={viewingDocVersionId}
                currentVersionId={sidePanelDoc
                    ? versionsByDocId.get(sidePanelDoc.id)?.currentVersionId ?? null : null}
                versions={sidePanelDoc
                    ? versionsByDocId.get(sidePanelDoc.id)?.versions ?? [] : []}
                versionsLoading={sidePanelDoc
                    ? loadingVersionDocIds.has(sidePanelDoc.id) : false}
                onClose={() => {
                    set("viewingDoc", null);
                    set("viewingDocVersionId", null);
                }}
                onLoadVersions={loadDocumentVersions}
                onSelectVersion={(id) => set("viewingDocVersionId", id)}
                onDownloadDocument={downloadDoc}
                onDownloadVersion={downloadDocVersion}
                onRenameVersion={handleRenameVersion}
                onDeleteVersion={handleDeleteVersion}
                onUploadNewVersion={submitNewVersion}
                onReplaceVersion={replaceVersionFile}
                canDelete={!isSharedDocument(sidePanelDoc)}
                onOwnerOnlyAction={onOwnerOnlyAction}
                onDelete={(doc) => handleRemoveDocuments([doc.id], false)}
                documentRemovalMode={documentRemovalMode} />
        </div>
    );
}

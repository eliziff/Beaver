"use client";
import {
    type Dispatch,
    type DragEvent,
    type ReactNode,
    type SetStateAction,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    Loader2,
    AlertCircle,
    ChevronDown,
    ChevronRight,
} from "lucide-react";
import {
    deleteDocument,
    getDocumentUrl,
    downloadDocumentsZip,
    listDocumentVersions,
    uploadDocumentVersion,
    replaceDocumentVersionFile,
    deleteDocumentVersion,
    renameDocumentVersion,
    type DocumentVersion,
} from "@/app/lib/beaverApi";
import { downloadBlob, downloadUrl } from "@/app/lib/download";
import type {
    Document,
    Folder as ProjectFolder,
    LibraryFolder,
} from "@/app/components/shared/types";
import { RowActions } from "@/app/components/shared/RowActions";import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";import { useAuth } from "@/app/contexts/AuthContext";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
    filenameExtensionChangeWarning,
    hasFilenameExtensionChange,
} from "@/app/lib/documentFilename";
import {
    formatUnsupportedDocumentWarning,
    partitionSupportedDocumentFiles,
    SUPPORTED_DOCUMENT_ACCEPT,
} from "@/app/lib/documentUploadValidation";
import {
    DOC_NAME_COL_W,    treeNameCellStyle,} from "@/app/components/projects/ProjectPageParts";import { formatBytes, formatDate } from "@/app/lib/utils";import { DocumentSidePanel } from "@/app/components/shared/DocumentSidePanel";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";
import {
    TableHeaderCell,
    TableHeaderRow,
    TableScrollArea,
    TableSelectionPlaceholder,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { CheckboxControl } from "@/app/components/ui/checkbox";
import { pillButtonClassName } from "@/app/components/ui/pill-button";
import { preloadSingleDoc } from "@/app/hooks/useFetchSingleDoc";
import { getPdfJs } from "@/app/components/shared/views/highlightQuote";
export type DocTableFolder = ProjectFolder | LibraryFolder;
export interface DocTableSelectionActions {
    selectedCount: number;
    selectedDocuments: Document[];
    automationDocument: Document | null;
    hasDocumentsInFolders: boolean;
    onAutomationDocumentChanged: () => Promise<void>;
    onDownload: () => Promise<void>;
    onRemoveFromFolder: () => Promise<void>;
    onDelete: () => Promise<void>;
}
const DOCUMENT_ROW_CLASS =
    "group flex h-11 min-h-11 w-full min-w-0 items-center border-b border-gray-100 pr-2";
const DOCUMENT_TYPE_COLUMN = "hidden w-20 shrink-0 sm:block";
const DOCUMENT_SIZE_COLUMN = "hidden w-24 shrink-0 md:block";
const DOCUMENT_VERSION_COLUMN = "w-20 shrink-0";
const DOCUMENT_CREATED_COLUMN = "hidden w-32 shrink-0 lg:block";
const DOCUMENT_UPDATED_COLUMN = "hidden w-32 shrink-0 xl:block";
function prewarmDocumentView(doc: Document) {
    const type = (doc.file_type ?? doc.filename.split(".").pop() ?? "")
        .toLowerCase()
        .replace(/^\./u, "");
    if (type === "pdf" || !!doc.pdf_storage_path) {
        void getPdfJs();
        void preloadSingleDoc(
            doc.id,
            doc.current_version_id,
            doc.updated_at,
        ).catch(() => {});
    } else if (type === "doc" || type === "docx") {
        void import("docx-preview");
    }
}
interface DocTableOperations {
    removeDocument?: (documentId: string) => Promise<void>;
    uploadDocument: (file: File) => Promise<Document>;
    refreshCollection: () => Promise<void>;
    createFolder: (
        name: string,
        parentFolderId?: string | null,
    ) => Promise<DocTableFolder>;
    renameFolder: (
        folderId: string,
        name: string,
    ) => Promise<DocTableFolder>;
    deleteFolder: (folderId: string) => Promise<void>;
    moveFolder: (
        folderId: string,
        parentFolderId: string | null,
    ) => Promise<DocTableFolder>;
    moveDocument: (
        documentId: string,
        folderId: string | null,
    ) => Promise<Document>;
    renameDocument: (documentId: string, filename: string) => Promise<Document>;
}
interface DocTableProps {
    scopeKey: string;
    documents: Document[];
    setDocuments: Dispatch<SetStateAction<Document[]>>;
    folders: DocTableFolder[];
    setFolders: Dispatch<SetStateAction<DocTableFolder[]>>;
    loading: boolean;
    search: string;
    operations: DocTableOperations;
    emptyDropLabel?: string;
    renderAddDocumentsModal?: (
        open: boolean,
        onClose: () => void,
        onSelect: (documents: Document[]) => void,
    ) => ReactNode;
    onAddDocumentsActionChange?: (action: (() => void) | null) => void;
    onCreateFolderActionChange?: (action: (() => void) | null) => void;
    onSelectionActionsChange?: (actions: DocTableSelectionActions | null) => void;
    onOwnerOnlyAction?: Dispatch<SetStateAction<string | null>>;
    documentRemovalMode?: "delete" | "detach";
    selectionFirst?: boolean;
}
function documentVersionNumber(doc: Document): number | null {
    return doc.active_version_number ?? null;
}
function ProjectTableLoadingHeader({
    stickyCellBg,
}: {
    stickyCellBg: string;
}) {
    return (
        <TableHeaderRow className={`${stickyCellBg} !min-w-0 w-full pr-2`}>
            <TableStickyCell
                header
                widthClassName={DOC_NAME_COL_W}
                bgClassName={stickyCellBg}
            >
                <TableSelectionPlaceholder />
                <span
                    aria-hidden="true"
                    className="mr-2 h-4 w-4 shrink-0"
                />
                <span className="mr-1">Name</span>
            </TableStickyCell>
            <TableHeaderCell className="ml-auto hidden w-20 items-center gap-1 sm:flex">
                <span>Type</span>
            </TableHeaderCell>
            <TableHeaderCell className="hidden w-24 items-center gap-1 md:flex">
                <span>Size</span>
            </TableHeaderCell>
            <TableHeaderCell className="flex w-20 items-center gap-1">
                <span>Version</span>
            </TableHeaderCell>
            <TableHeaderCell className="hidden w-32 items-center gap-1 lg:flex">
                <span>Created</span>
            </TableHeaderCell>
            <TableHeaderCell className="hidden w-32 items-center gap-1 xl:flex">
                <span>Updated</span>
            </TableHeaderCell>
            <TableHeaderCell className="w-8" />
        </TableHeaderRow>
    );
}
function ProjectTableLoading({ stickyCellBg }: { stickyCellBg: string }) {
    return (
        <div className="flex-1 flex flex-col min-h-0">
            {[1, 2, 3, 4, 5].map((i) => (
                <div
                    key={i}
                    className={DOCUMENT_ROW_CLASS}
                >
                    <div
                        className={`sticky left-0 z-[60] ${DOC_NAME_COL_W} ${stickyCellBg} py-2 pl-4 pr-2`}
                    >
                        <div className="flex items-center">
                            <TableSelectionPlaceholder />
                            <div className="mr-2 h-4 w-4 shrink-0 rounded bg-gray-100" />
                            <div
                                className="h-3.5 rounded bg-gray-100"
                                style={{ width: `${210 + i * 16}px` }}
                            />
                        </div>
                    </div>
                    <div className={`${DOCUMENT_TYPE_COLUMN} ml-auto`}>
                        <div className="h-3 w-8 rounded bg-gray-100" />
                    </div>
                    <div className={DOCUMENT_SIZE_COLUMN}>
                        <div className="h-3 w-12 rounded bg-gray-100" />
                    </div>
                    <div className={DOCUMENT_VERSION_COLUMN}>
                        <div className="h-3 w-5 rounded bg-gray-100" />
                    </div>
                    <div className={DOCUMENT_CREATED_COLUMN}>
                        <div className="h-3 w-16 rounded bg-gray-100" />
                    </div>
                    <div className={DOCUMENT_UPDATED_COLUMN}>
                        <div className="h-3 w-16 rounded bg-gray-100" />
                    </div>
                    <div className="w-8 shrink-0" />
                </div>
            ))}
        </div>
    );
}
export function DocTable({
    scopeKey,
    documents,
    setDocuments,
    folders,
    setFolders,
    loading,
    search,
    operations,
    emptyDropLabel = "Drop PDF, Word, Excel, or PowerPoint files here",
    renderAddDocumentsModal,
    onAddDocumentsActionChange,
    onCreateFolderActionChange,
    onSelectionActionsChange,
    onOwnerOnlyAction,
    documentRemovalMode = "delete",
    selectionFirst = false,
}: DocTableProps) {
    const [addDocsOpen, setAddDocsOpen] = useState(false);
    const { user } = useAuth();
    const stickyCellBg = "bg-app-surface";
    const [viewingDoc, setViewingDoc] = useState<Document | null>(null);
    const [viewingDocVersion, setViewingDocVersion] = useState<{
        id: string;
        label: string;
    } | null>(null);
    const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
    const documentUploadInputRef = useRef<HTMLInputElement>(null);
    const loadingRef = useRef(loading);
    const renderAddDocumentsModalRef = useRef(renderAddDocumentsModal);
    const setOwnerOnlyAction = useMemo(
        () => onOwnerOnlyAction ?? (() => {}),
        [onOwnerOnlyAction],
    );
    const detachesDocument = documentRemovalMode === "detach";
    const removeDocument = operations.removeDocument ?? deleteDocument;
    const refreshCollection = operations.refreshCollection;
    useEffect(() => {
        loadingRef.current = loading;
        renderAddDocumentsModalRef.current = renderAddDocumentsModal;
    }, [loading, renderAddDocumentsModal]);
    const openAddDocuments = useCallback(() => {
        if (loadingRef.current) return;
        if (renderAddDocumentsModalRef.current) {
            setAddDocsOpen(true);
            return;
        }
        documentUploadInputRef.current?.click();
    }, []);
    useEffect(() => {
        onAddDocumentsActionChange?.(openAddDocuments);
        return () => onAddDocumentsActionChange?.(null);
    }, [onAddDocumentsActionChange, openAddDocuments]);
    const [versionsByDocId, setVersionsByDocId] = useState<
        Map<
            string,
            { currentVersionId: string | null; versions: DocumentVersion[] }
        >
    >(() => new Map());
    const [loadingVersionDocIds, setLoadingVersionDocIds] = useState<
        Set<string>
    >(() => new Set());
    const loadDocumentVersions = async (docId: string) => {
        if (versionsByDocId.has(docId)) return;
        setLoadingVersionDocIds((prev) => new Set([...prev, docId]));
        try {
            const res = await listDocumentVersions(docId);
            setVersionsByDocId((prev) => {
                const next = new Map(prev);
                next.set(docId, {
                    currentVersionId: res.current_version_id,
                    versions: res.versions,
                });
                return next;
            });
        } catch (e) {
            console.error("listDocumentVersions failed", e);
        } finally {
            setLoadingVersionDocIds((prev) => {
                const next = new Set(prev);
                next.delete(docId);
                return next;
            });
        }
    };
    async function downloadDocVersion(
        docId: string,
        versionId: string,
        filename: string,
    ) {
        try {
            const resolved = await getDocumentUrl(docId, versionId);
            downloadUrl(resolved.url, resolved.filename || filename);
        } catch (e) {
            console.error("downloadDocVersion failed", e);
        }
    }
    function handleUploadNewVersion(doc: Document) {
        setVersionUploadTargetDoc(doc);
        window.setTimeout(() => versionUploadInputRef.current?.click(), 0);
    }
    async function handleVersionUploadInputChange(
        e: React.ChangeEvent<HTMLInputElement>,
    ) {
        const file = e.target.files?.[0] ?? null;
        e.target.value = "";
        const doc = versionUploadTargetDoc;
        setVersionUploadTargetDoc(null);
        if (!file || !doc) return;
        await handleDropDocumentVersions(doc, [file]);
    }
    async function submitNewVersion(
        doc: Document,
        file: File,
        filename: string,
    ) {
        try {
            await uploadDocumentVersion(doc.id, file, filename);
            await refreshDocumentVersionState(doc.id);
        } catch (e) {
            console.error("uploadDocumentVersion failed", e);
        }
    }
    async function replaceVersionFile(
        docId: string,
        versionId: string,
        file: File,
        filename: string,
    ) {
        await replaceDocumentVersionFile(docId, versionId, file, filename);
        const res = await refreshDocumentVersionState(docId);
        const replaced = res.versions.find(
            (version) => version.id === versionId,
        );
        if (replaced) {
            setViewingDocVersion({
                id: replaced.id,
                label: replaced.filename?.trim() || "Version",
            });
        }
    }
    const refreshDocumentVersionState = useCallback(async (docId: string) => {
        await refreshCollection();
        const res = await listDocumentVersions(docId);
        setVersionsByDocId((prev) => {
            const next = new Map(prev);
            next.set(docId, {
                currentVersionId: res.current_version_id,
                versions: res.versions,
            });
            return next;
        });
        return res;
    }, [refreshCollection]);
    async function handleRenameVersion(
        docId: string,
        versionId: string,
        filename: string | null,
    ) {
        const previousFilename = versionsByDocId
            .get(docId)
            ?.versions.find((version) => version.id === versionId)
            ?.filename?.trim();
        if (
            previousFilename &&
            (filename == null ||
                hasFilenameExtensionChange(previousFilename, filename))
        ) {
            setDocumentRenameWarning(
                filenameExtensionChangeWarning(previousFilename),
            );
            return;
        }
        try {
            const updated = await renameDocumentVersion(
                docId,
                versionId,
                filename,
            );
            setVersionsByDocId((prev) => {
                const cached = prev.get(docId);
                if (!cached) return prev;
                const next = new Map(prev);
                next.set(docId, {
                    ...cached,
                    versions: cached.versions.map((v) =>
                        v.id === versionId ? updated : v,
                    ),
                });
                return next;
            });
        } catch (e) {
            console.error("renameDocumentVersion failed", e);
        }
    }
    async function handleDeleteVersion(docId: string, versionId: string) {
        try {
            await deleteDocumentVersion(docId, versionId);
            const res = await refreshDocumentVersionState(docId);
            const activeVersions = res.versions.filter(
                (version) => version.deleted_at == null,
            );
            const nextVersion =
                activeVersions.find(
                    (version) => version.id === res.current_version_id,
                ) ??
                activeVersions[activeVersions.length - 1] ??
                null;
            setViewingDocVersion(
                nextVersion
                    ? {
                          id: nextVersion.id,
                          label: nextVersion.filename?.trim() || "Version",
                      }
                    : null,
            );
        } catch (e) {
            console.error("deleteDocumentVersion failed", e);
            setDocumentRenameWarning("Could not delete this version.");
        }
    }
    const [renamingDocumentId, setRenamingDocumentId] = useState<string | null>(
        null,
    );
    const [renameDocumentValue, setRenameDocumentValue] = useState("");
    const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(
        new Set(),
    );
    const [creatingFolderIn, setCreatingFolderIn] = useState<
        string | null | undefined
    >(undefined);
    const [newFolderName, setNewFolderName] = useState("");
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(
        null,
    );
    const [renameFolderValue, setRenameFolderValue] = useState("");
    const newFolderInputRef = useRef<HTMLDivElement | null>(null);
    const versionUploadInputRef = useRef<HTMLInputElement>(null);
    const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(
        null,
    );
    const [dragOverRoot, setDragOverRoot] = useState(false);
    const [dragOverVersionDocId, setDragOverVersionDocId] = useState<
        string | null
    >(null);
    const [uploadingVersionDocIds, setUploadingVersionDocIds] = useState<
        Set<string>
    >(() => new Set());
    const [versionUploadTargetDoc, setVersionUploadTargetDoc] =
        useState<Document | null>(null);
    const [uploadingDroppedFilenames, setUploadingDroppedFilenames] = useState<
        string[]
    >([]);
    const [deletingDocIds, setDeletingDocIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [documentUploadWarning, setDocumentUploadWarning] = useState<
        string | null
    >(null);
    const [documentRenameWarning, setDocumentRenameWarning] = useState<
        string | null
    >(null);
    const [collectionActionWarning, setCollectionActionWarning] = useState<
        string | null
    >(null);
    const [pendingDocumentRemoval, setPendingDocumentRemoval] = useState<{
        documents: Document[];
        fromSelection: boolean;
    } | null>(null);
    const [documentRemovalStatus, setDocumentRemovalStatus] = useState<
        "idle" | "deleting" | "deleted"
    >("idle");
    const [pendingDeleteFolder, setPendingDeleteFolder] = useState<{
        folder: DocTableFolder;
        folderIds: string[];
        documentIds: string[];
        documentCount: number;
    } | null>(null);
    const [pendingDeleteFolderStatus, setPendingDeleteFolderStatus] = useState<
        "idle" | "deleting" | "deleted"
    >("idle");
    const openCreateFolder = useCallback(() => {
        if (loadingRef.current) return;
        setCreatingFolderIn(null);
        setNewFolderName("");
    }, []);
    useEffect(() => {
        onCreateFolderActionChange?.(openCreateFolder);
        return () => onCreateFolderActionChange?.(null);
    }, [onCreateFolderActionChange, openCreateFolder]);
    useEffect(() => {
        if (loading) return;
        setExpandedFolderIds(new Set(folders.map((f) => f.id)));
    }, [loading, folders]);
    useEffect(() => {
        setSelectedDocIds([]);
    }, [scopeKey]);
    useEffect(() => {
        function handleDragEnd() {
            setDragOverFolderId(null);
            setDragOverRoot(false);
        }
        document.addEventListener("dragend", handleDragEnd);
        return () => document.removeEventListener("dragend", handleDragEnd);
    }, []);
    useEffect(() => {
        if (creatingFolderIn !== undefined) {
            newFolderInputRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "nearest",
            });
        }
    }, [creatingFolderIn]);
    function toggleFolder(id: string) {
        setExpandedFolderIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }
    async function handleCreateFolder(parentId: string | null) {
        const name = newFolderName.trim();
        setNewFolderName("");
        if (!name) {
            setCreatingFolderIn(undefined);
            return;
        }
        setCreatingFolderIn(undefined);
        const tempId = `temp-${Date.now()}`;
        const optimistic = {
            id: tempId,
            user_id: "",
            name,
            parent_folder_id: parentId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        } as DocTableFolder;
        setFolders((prev) => [...prev, optimistic]);
        setExpandedFolderIds((prev) => new Set([...prev, tempId]));
        if (parentId)
            setExpandedFolderIds((prev) => new Set([...prev, parentId]));
        const folder = await operations.createFolder(name, parentId ?? null);
        setFolders((prev) => prev.map((f) => (f.id === tempId ? folder : f)));
        setExpandedFolderIds((prev) => {
            const next = new Set(prev);
            next.delete(tempId);
            next.add(folder.id);
            return next;
        });
    }
    async function handleRenameFolder(folderId: string) {
        const name = renameFolderValue.trim();
        setRenamingFolderId(null);
        if (!name) return;
        setFolders((prev) =>
            prev.map((f) => (f.id === folderId ? { ...f, name } : f)),
        );
        await operations.renameFolder(folderId, name);
    }
    function folderDeleteImpact(folderId: string) {
        const childrenByParent = new Map<string, string[]>();
        for (const folder of folders) {
            if (!folder.parent_folder_id) continue;
            const children =
                childrenByParent.get(folder.parent_folder_id) ?? [];
            children.push(folder.id);
            childrenByParent.set(folder.parent_folder_id, children);
        }
        const toDelete = new Set<string>();
        const stack = [folderId];
        while (stack.length > 0) {
            const id = stack.pop();
            if (!id || toDelete.has(id)) continue;
            toDelete.add(id);
            stack.push(...(childrenByParent.get(id) ?? []));
        }
        const folderIds = [...toDelete];
        const documentIds = documents
            .filter((d) => d.folder_id && toDelete.has(d.folder_id))
            .map((d) => d.id);
        return { folderIds, documentIds, documentCount: documentIds.length };
    }
    function requestDeleteFolder(folderId: string) {
        const folder = folders.find((f) => f.id === folderId);
        if (!folder) return;
        const impact = folderDeleteImpact(folderId);
        setPendingDeleteFolderStatus("idle");
        setPendingDeleteFolder({
            folder,
            folderIds: impact.folderIds,
            documentIds: impact.documentIds,
            documentCount: impact.documentCount,
        });
    }
    async function confirmDeletePendingFolder() {
        const pending = pendingDeleteFolder;
        if (!pending || pendingDeleteFolderStatus === "deleting") return;
        setPendingDeleteFolderStatus("deleting");
        try {
            await operations.deleteFolder(pending.folder.id);
            const toDelete = new Set(pending.folderIds);
            setFolders((prev) => prev.filter((f) => !toDelete.has(f.id)));
            setDocuments((prev) =>
                prev.filter((d) => !d.folder_id || !toDelete.has(d.folder_id)),
            );
            setExpandedFolderIds((prev) => {
                const next = new Set(prev);
                for (const id of toDelete) next.delete(id);
                return next;
            });
            if (renamingFolderId && toDelete.has(renamingFolderId)) {
                setRenamingFolderId(null);
            }
            const deletedDocIds = new Set(pending.documentIds);
            setSelectedDocIds((prev) =>
                prev.filter((id) => !deletedDocIds.has(id)),
            );
            setVersionsByDocId((prev) => {
                const next = new Map(prev);
                for (const id of pending.documentIds) next.delete(id);
                return next;
            });
            setPendingDeleteFolderStatus("deleted");
            window.setTimeout(() => {
                setPendingDeleteFolder(null);
                setPendingDeleteFolderStatus("idle");
            }, 650);
        } catch (err) {
            console.error("delete folder failed", err);
            setPendingDeleteFolderStatus("idle");
            setCollectionActionWarning(
                "Folder could not be deleted. Please try again.",
            );
        }
    }
    function handleDocsSelected(newDocs: Document[]) {
        setDocuments((prev) =>
            [
                ...prev,
                ...newDocs.filter((d) => !prev.some((e) => e.id === d.id)),
            ],
        );
    }
    async function handleRemoveDocFromFolder(docId: string) {
        setDocuments((prev) =>
            prev.map((d) =>
                d.id === docId ? { ...d, folder_id: null } : d,
            ),
        );
        await operations.moveDocument(docId, null);
    }
    async function submitDocumentRename(docId: string) {
        const trimmed = renameDocumentValue.trim();
        if (!trimmed) {
            setRenamingDocumentId(null);
            return;
        }
        const previous = documents.find((d) => d.id === docId);
        if (!previous || trimmed === previous.filename) {
            setRenamingDocumentId(null);
            return;
        }
        if (hasFilenameExtensionChange(previous.filename, trimmed)) {
            setDocumentRenameWarning(
                filenameExtensionChangeWarning(previous.filename),
            );
            return;
        }
        setRenamingDocumentId(null);
        setDocuments((prev) =>
            prev.map((d) =>
                d.id === docId
                    ? {
                          ...d,
                          filename: trimmed,
                          updated_at: new Date().toISOString(),
                      }
                    : d,
            ),
        );
        try {
            const updated = await operations.renameDocument(docId, trimmed);
            setDocuments((prev) =>
                prev.map((d) => (d.id === docId ? { ...d, ...updated } : d)),
            );
        } catch (e) {
            console.error("renameDocument failed", e);
            setDocuments((prev) =>
                previous
                    ? prev.map((d) => (d.id === docId ? previous : d))
                    : prev,
            );
        }
    }
    async function handleRemoveDocuments(
        documentIds: string[],
        fromSelection: boolean,
    ) {
        const owned = documentIds.filter((id) => {
            const doc = documents.find((candidate) => candidate.id === id);
            return !doc || !doc.user_id || !user?.id || doc.user_id === user.id;
        });
        const blocked = documentIds.length - owned.length;
        if (!fromSelection && blocked) {
            setOwnerOnlyAction(
                detachesDocument
                    ? "remove this document from the project"
                    : "delete this document",
            );
            return;
        }
        if (fromSelection) {
            setSelectedDocIds([]);
        } else {
            setDeletingDocIds((prev) => new Set([...prev, ...owned]));
        }
        try {
            const results = await Promise.allSettled(
                owned.map((id) => removeDocument(id)),
            );
            const removedIds = owned.filter(
                (_, index) => results[index].status === "fulfilled",
            );
            if (removedIds.length) {
                setDocuments((prev) =>
                    prev.filter((doc) => !removedIds.includes(doc.id)),
                );
            }
            if (fromSelection && removedIds.length) {
                setVersionsByDocId((prev) => {
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
            const failed = owned.length - removedIds.length;
            if (failed) {
                setCollectionActionWarning(
                    `${failed} ${failed === 1 ? "document" : "documents"} could not be ${
                        detachesDocument
                            ? "removed from this project"
                            : "deleted"
                    }. Please try again.`,
                );
            }
            if (blocked) {
                setOwnerOnlyAction(
                    detachesDocument
                        ? `remove ${blocked} of the selected documents \u2014 only the document creator can remove a document from this project`
                        : `delete ${blocked} of the selected documents \u2014 only the document creator can delete a document`,
                );
            }
        } finally {
            if (!fromSelection) {
                setDeletingDocIds((prev) => {
                    const next = new Set(prev);
                    for (const id of owned) next.delete(id);
                    return next;
                });
            }
        }
    }
    function requestRemoveDoc(doc: Document) {
        if (doc && user?.id && doc.user_id && doc.user_id !== user.id) {
            setOwnerOnlyAction(
                detachesDocument
                    ? "remove this document from the project"
                    : "delete this document",
            );
            return;
        }
        setDocumentRemovalStatus("idle");
        setPendingDocumentRemoval({
            documents: [doc],
            fromSelection: false,
        });
    }
    function wouldCreateCycle(movingId: string, targetId: string): boolean {
        let cur: DocTableFolder | undefined = folders.find(
            (f) => f.id === targetId,
        );
        while (cur) {
            if (cur.id === movingId) return true;
            if (!cur.parent_folder_id) break;
            cur = folders.find((f) => f.id === cur!.parent_folder_id);
        }
        return false;
    }
    function hasMovePayload(dt: DataTransfer): boolean {
        return Array.from(dt.types).some(
            (type) =>
                type === "application/mike-doc" ||
                type === "application/mike-folder",
        );
    }
    function hasFilePayload(dt: DataTransfer): boolean {
        return Array.from(dt.types).includes("Files");
    }
    function currentVersionNumber(doc: Document): number | null {
        return documentVersionNumber(doc);
    }
    function isSharedDocument(doc: Document | null | undefined): boolean {
        return !!(doc?.user_id && user?.id && doc.user_id !== user.id);
    }
    async function handleDropCollectionFiles(files: File[]) {
        if (files.length === 0) return;
        const { supported, unsupported } =
            partitionSupportedDocumentFiles(files);
        setDocumentUploadWarning(formatUnsupportedDocumentWarning(unsupported));
        if (supported.length === 0) return;
        setUploadingDroppedFilenames(supported.map((file) => file.name));
        try {
            const uploaded = await Promise.all(
                supported.map((file) => operations.uploadDocument(file)),
            );
            handleDocsSelected(uploaded);
        } catch (err) {
            console.error("Document drop upload failed", err);
        } finally {
            setUploadingDroppedFilenames([]);
        }
    }
    async function handleDropDocumentVersions(doc: Document, files: File[]) {
        if (files.length === 0) return;
        const { supported, unsupported } =
            partitionSupportedDocumentFiles(files);
        setDocumentUploadWarning(formatUnsupportedDocumentWarning(unsupported));
        if (supported.length === 0) return;
        setUploadingVersionDocIds((prev) => new Set([...prev, doc.id]));
        try {
            for (const file of supported) {
                await uploadDocumentVersion(doc.id, file, file.name);
            }
            await refreshDocumentVersionState(doc.id);
        } catch (err) {
            console.error("Document version drop upload failed", err);
        } finally {
            setUploadingVersionDocIds((prev) => {
                const next = new Set(prev);
                next.delete(doc.id);
                return next;
            });
        }
    }
    function handleDocumentVersionDragOver(
        e: DragEvent<HTMLDivElement>,
        docId: string,
    ) {
        if (!hasFilePayload(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragOverVersionDocId(docId);
        setDragOverRoot(false);
    }
    function handleDocumentVersionDragLeave(e: DragEvent<HTMLDivElement>) {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setDragOverVersionDocId(null);
        }
    }
    function handleDocumentVersionDrop(
        e: DragEvent<HTMLDivElement>,
        doc: Document,
    ) {
        if (!hasFilePayload(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        setDragOverVersionDocId(null);
        setDragOverRoot(false);
        setDragOverFolderId(null);
        void handleDropDocumentVersions(doc, Array.from(e.dataTransfer.files));
    }
    async function handleDropOnFolder(
        targetFolderId: string | null,
        dt: DataTransfer,
    ) {
        if (!hasMovePayload(dt)) return;
        const docId = dt.getData("application/mike-doc");
        const subFolderId = dt.getData("application/mike-folder");
        if (docId) {
            const doc = documents.find((d) => d.id === docId);
            if (!doc || (doc.folder_id ?? null) === targetFolderId) return;
            setDocuments((prev) =>
                prev.map((d) =>
                    d.id === docId ? { ...d, folder_id: targetFolderId } : d,
                ),
            );
            await operations.moveDocument(docId, targetFolderId);
        } else if (subFolderId && subFolderId !== targetFolderId) {
            if (
                targetFolderId !== null &&
                wouldCreateCycle(subFolderId, targetFolderId)
            )
                return;
            const folder = folders.find((f) => f.id === subFolderId);
            if (!folder || (folder.parent_folder_id ?? null) === targetFolderId)
                return;
            setFolders((prev) =>
                prev.map((f) =>
                    f.id === subFolderId
                        ? { ...f, parent_folder_id: targetFolderId }
                        : f,
                ),
            );
            await operations.moveFolder(subFolderId, targetFolderId);
        }
    }
    function renderFolderInput(parentId: string | null, depth: number) {
        if (creatingFolderIn !== parentId) return null;
        return (
            <div
                ref={newFolderInputRef}
                className={DOCUMENT_ROW_CLASS}
                key={`new-folder-${parentId ?? "root"}`}
            >
                <div
                    className={`sticky left-0 z-[60] ${DOC_NAME_COL_W} ${stickyCellBg} py-2 pl-4 pr-2`}
                    style={treeNameCellStyle(depth)}
                >
                    <div className="flex items-center">
                        <span className="mr-4 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                            <ChevronRight className="h-3.5 w-3.5 text-gray-300" />
                        </span>
                        <FolderSvgIcon className="mr-2 h-4 w-4 shrink-0" />
                        <input
                            autoFocus
                            className="flex-1 min-w-0 text-sm text-gray-800 bg-transparent outline-none border-b border-gray-300"
                            placeholder="Folder name"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter")
                                    void handleCreateFolder(parentId);
                                if (e.key === "Escape") {
                                    setCreatingFolderIn(undefined);
                                    setNewFolderName("");
                                }
                            }}
                            onBlur={() => void handleCreateFolder(parentId)}
                        />
                    </div>
                </div>
                <div className={`${DOCUMENT_TYPE_COLUMN} ml-auto`} />
                <div className={DOCUMENT_SIZE_COLUMN} />
                <div className={DOCUMENT_VERSION_COLUMN} />
                <div className={DOCUMENT_CREATED_COLUMN} />
                <div className={DOCUMENT_UPDATED_COLUMN} />
                <div className="w-8 shrink-0" />
            </div>
        );
    }
    function renderDocumentActivityRow({
        key,
        filename,
        fileType,
        depth,
        statusLabel,
    }: {
        key: string;
        filename: string;
        fileType: string | null;
        depth: number;
        statusLabel: string;
    }) {
        return (
            <div
                key={key}
                className={DOCUMENT_ROW_CLASS}
            >
                <div
                    className={`sticky left-0 z-[60] ${DOC_NAME_COL_W} ${stickyCellBg} py-2 pl-4 pr-2`}
                    style={treeNameCellStyle(depth)}
                >
                    <div className="flex items-center">
                        <Loader2 className="mr-4 h-2.5 w-2.5 animate-spin text-gray-400 shrink-0" />
                        <span className="mr-2 shrink-0">
                            <FileTypeIcon                                fileType={fileType ?? filename}                                className="h-4 w-4"                                muted                            />                        </span>
                        <span className="text-sm text-gray-400 truncate">
                            {filename}
                        </span>
                    </div>
                </div>
                <div className={`${DOCUMENT_TYPE_COLUMN} ml-auto text-xs text-gray-300 uppercase truncate`}>
                    {fileType ??
                        (filename.includes(".")
                            ? filename.split(".").pop()
                            : "file")}
                </div>
                <div className={`${DOCUMENT_SIZE_COLUMN} text-sm text-gray-300`}>
                    {statusLabel}
                </div>
                <div className={`${DOCUMENT_VERSION_COLUMN} text-sm text-gray-300`}>—</div>
                <div className={`${DOCUMENT_CREATED_COLUMN} text-sm text-gray-300`}>—</div>
                <div className={`${DOCUMENT_UPDATED_COLUMN} text-sm text-gray-300`}>—</div>
                <div className="w-8 shrink-0" />
            </div>
        );
    }
    function renderUploadingDocumentRows(depth: number) {
        return uploadingDroppedFilenames.map((filename) =>
            renderDocumentActivityRow({
                key: `uploading-doc-${filename}`,
                filename,
                fileType: null,
                depth,
                statusLabel: "Uploading",
            }),
        );
    }
    function openDocument(doc: Document) {
        prewarmDocumentView(doc);
        setViewingDocVersion(null);
        setViewingDoc(doc);
    }
    function toggleDocumentSelection(docId: string) {
        setSelectedDocIds((prev) =>
            prev.includes(docId)
                ? prev.filter((id) => id !== docId)
                : [...prev, docId],
        );
    }
    function renderLevel(
        parentId: string | null,
        depth: number,
        flat = false,
    ) {
        const childFolders = flat
            ? []
            : folders
                  .filter((f) => f.parent_folder_id === parentId)
                  .sort((a, b) => a.name.localeCompare(b.name));
        const childDocs = flat
            ? filteredDocs
            : filteredDocs.filter(
                  (d) => (d.folder_id ?? null) === parentId,
              );
        return (
            <>
                {parentId === null && renderUploadingDocumentRows(depth)}
                {/* Files first */}
                {childDocs.map((doc) => {
                    const docName = doc.filename;
                    const isProcessing =
                        doc.status === "pending" || doc.status === "processing";
                    const isError = doc.status === "error";
                    const versionNumber = currentVersionNumber(doc);
                    const hasVersions =
                        typeof versionNumber === "number" && versionNumber > 1;
                    const isVersionDragOver = dragOverVersionDocId === doc.id;
                    const isUploadingVersion = uploadingVersionDocIds.has(
                        doc.id,
                    );
                    const isSelected = selectedDocIds.includes(doc.id);
                    const isDeletingDoc = deletingDocIds.has(doc.id);
                    if (isDeletingDoc) {
                        return renderDocumentActivityRow({
                            key: `deleting-doc-${doc.id}`,
                            filename: doc.filename,
                            fileType: doc.file_type,
                            depth,
                            statusLabel: "Deleting...",
                        });
                    }
                    return (
                        <div key={`doc-${doc.id}`}>
                            <div
                                data-document-row
                                draggable={renamingDocumentId !== doc.id}
                                onDragStart={(e) => {
                                    if (renamingDocumentId === doc.id) {
                                        e.preventDefault();
                                        return;
                                    }
                                    e.dataTransfer.setData(
                                        "application/mike-doc",
                                        doc.id,
                                    );
                                    e.dataTransfer.effectAllowed = "copyMove";
                                }}
                                onDragEnd={() => {
                                    setDragOverRoot(false);
                                    setDragOverFolderId(null);
                                    setDragOverVersionDocId(null);
                                }}
                                onDragOver={(e) =>
                                    handleDocumentVersionDragOver(e, doc.id)
                                }
                                onDragLeave={handleDocumentVersionDragLeave}
                                onDrop={(e) =>
                                    handleDocumentVersionDrop(e, doc)
                                }
                                onClick={() => {
                                    if (selectionFirst) {
                                        setSelectedDocIds([doc.id]);
                                    } else {
                                        openDocument(doc);
                                    }
                                }}
                                onDoubleClick={
                                    selectionFirst
                                        ? (event) => {
                                              if (
                                                  event.target instanceof Element &&
                                                  event.target.closest(
                                                      "button, input, select, textarea",
                                                  )
                                              ) {
                                                  return;
                                              }
                                              setSelectedDocIds([doc.id]);
                                              openDocument(doc);
                                          }
                                        : undefined
                                }
                                onKeyDown={
                                    selectionFirst
                                        ? (event) => {
                                              if (
                                                  event.target !==
                                                  event.currentTarget
                                              ) {
                                                  return;
                                              }
                                              if (event.key === "Enter") {
                                                  event.preventDefault();
                                                  setSelectedDocIds([doc.id]);
                                                  openDocument(doc);
                                              } else if (event.key === " ") {
                                                  event.preventDefault();
                                                  toggleDocumentSelection(
                                                      doc.id,
                                                  );
                                              }
                                          }
                                        : undefined
                                }
                                tabIndex={selectionFirst ? 0 : undefined}
                                role={selectionFirst ? "row" : undefined}
                                aria-selected={
                                    selectionFirst ? isSelected : undefined
                                }
                                className={`${DOCUMENT_ROW_CLASS} cursor-pointer ${selectionFirst ? "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600" : ""} ${isVersionDragOver ? "bg-red-50 ring-1 ring-inset ring-red-200" : isSelected ? APP_SURFACE_ACTIVE_CLASS : `bg-app-surface ${APP_SURFACE_HOVER_CLASS}`}`}
                            >
                                            <div
                                                className={`sticky left-0 z-[60] ${DOC_NAME_COL_W} bg-inherit py-2 pl-4 pr-2`}
                                                style={treeNameCellStyle(depth)}
                                            >
                                                <div className="flex items-center">
                                                    {isProcessing ||
                                                    isUploadingVersion ? (
                                                        <span className="-ml-2 mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center">
                                                            <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                                                        </span>
                                                    ) : (
                                                        <CheckboxControl
                                                            checked={isSelected}
                                                            onChange={() =>
                                                                toggleDocumentSelection(
                                                                    doc.id,
                                                                )
                                                            }
                                                            onClick={(e) =>
                                                                e.stopPropagation()
                                                            }
                                                            className="-ml-2 mr-1"
                                                        />
                                                    )}
                                                    <span className="mr-2 shrink-0">
                                                        {isError ? (
                                                            <AlertCircle className="h-4 w-4 text-red-500" />
                                                        ) : (
                                                            <FileTypeIcon                                                                fileType={                                                                    doc.file_type                                                                }                                                                className="h-4 w-4"                                                            />                                                        )}
                                                    </span>
                                                    {renamingDocumentId ===
                                                    doc.id ? (
                                                        <input
                                                            autoFocus
                                                            className="min-w-0 flex-1 text-sm text-gray-800 bg-transparent outline-none border-b border-gray-300"
                                                            value={
                                                                renameDocumentValue
                                                            }
                                                            onClick={(e) =>
                                                                e.stopPropagation()
                                                            }
                                                            onDragStart={(
                                                                e,
                                                            ) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                            }}
                                                            onChange={(e) =>
                                                                setRenameDocumentValue(
                                                                    e.target
                                                                        .value,
                                                                )
                                                            }
                                                            onKeyDown={(e) => {
                                                                if (
                                                                    e.key ===
                                                                    "Enter"
                                                                )
                                                                    void submitDocumentRename(
                                                                        doc.id,
                                                                    );
                                                                if (
                                                                    e.key ===
                                                                    "Escape"
                                                                ) {
                                                                    setRenamingDocumentId(
                                                                        null,
                                                                    );
                                                                    setRenameDocumentValue(
                                                                        "",
                                                                    );
                                                                }
                                                            }}
                                                            onBlur={() =>
                                                                void submitDocumentRename(
                                                                    doc.id,
                                                                )
                                                            }
                                                        />
                                                    ) : (
                                                        <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                                                            {docName}
                                                        </span>
                                                    )}
                                                    {selectionFirst && (
                                                        <button
                                                            type="button"
                                                            aria-label={`View ${docName}`}
                                                            title={`View ${docName}`}
                                                            disabled={
                                                                renamingDocumentId ===
                                                                doc.id
                                                            }
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                setSelectedDocIds(
                                                                    [doc.id],
                                                                );
                                                                openDocument(
                                                                    doc,
                                                                );
                                                            }}
                                                            onPointerEnter={() =>
                                                                prewarmDocumentView(
                                                                    doc,
                                                                )
                                                            }
                                                            onFocus={() =>
                                                                prewarmDocumentView(
                                                                    doc,
                                                                )
                                                            }
                                                            className={pillButtonClassName(
                                                                "black",
                                                                "sm",
                                                                "ml-2 h-8 min-w-14 shrink-0 px-3 disabled:invisible",
                                                            )}
                                                        >
                                                            View
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                            <div className={`${DOCUMENT_TYPE_COLUMN} ml-auto text-xs text-gray-500 uppercase truncate`}>
                                                {doc.file_type ?? (
                                                    <span className="text-gray-300">
                                                        —
                                                    </span>
                                                )}
                                            </div>
                                            <div className={`${DOCUMENT_SIZE_COLUMN} text-sm text-gray-500 truncate`}>
                                                {doc.size_bytes != null ? (
                                                    formatBytes(doc.size_bytes)
                                                ) : (
                                                    <span className="text-gray-300">
                                                        —
                                                    </span>
                                                )}
                                            </div>
                                            <div
                                                className={`${DOCUMENT_VERSION_COLUMN} text-sm text-gray-500 flex items-center gap-1`}
                                                onClick={(e) =>
                                                    e.stopPropagation()
                                                }
                                            >
                                                {hasVersions ? (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            openDocument(doc)
                                                        }
                                                        onPointerEnter={() =>
                                                            prewarmDocumentView(
                                                                doc,
                                                            )
                                                        }
                                                        onFocus={() =>
                                                            prewarmDocumentView(
                                                                doc,
                                                            )
                                                        }
                                                        className={`flex h-8 min-w-8 items-center justify-center rounded-md px-2 ${APP_SURFACE_HOVER_CLASS}`}
                                                        title="Open version history"
                                                        aria-label={`Open version history for ${docName}`}
                                                    >
                                                        {versionNumber}
                                                    </button>
                                                ) : (
                                                    <span className="text-gray-300 pl-1">
                                                        —
                                                    </span>
                                                )}
                                            </div>
                                            <div className={`${DOCUMENT_CREATED_COLUMN} text-sm text-gray-500 truncate`}>
                                                {doc.created_at ? (
                                                    formatDate(doc.created_at)
                                                ) : (
                                                    <span className="text-gray-300">
                                                        —
                                                    </span>
                                                )}
                                            </div>
                                            <div className={`${DOCUMENT_UPDATED_COLUMN} text-sm text-gray-500 truncate`}>
                                                {doc.updated_at ? (
                                                    formatDate(doc.updated_at)
                                                ) : (
                                                    <span className="text-gray-300">
                                                        —
                                                    </span>
                                                )}
                                            </div>
                                            <div className="w-8 shrink-0 flex justify-end">
                                                {!isProcessing && (
                                                    <RowActions
                                                        onRename={() => {
                                                            setRenameDocumentValue(
                                                                docName,
                                                            );
                                                            setRenamingDocumentId(
                                                                doc.id,
                                                            );
                                                        }}
                                                        renameLabel="Rename document"
                                                        onDownload={() =>
                                                            downloadDoc(doc.id)
                                                        }
                                                        onUploadNewVersion={() =>
                                                            void handleUploadNewVersion(
                                                                doc,
                                                            )
                                                        }
                                                        onRemoveFromFolder={
                                                            doc.folder_id
                                                                ? () =>
                                                                      handleRemoveDocFromFolder(
                                                                          doc.id,
                                                                      )
                                                                : undefined
                                                        }
                                                        onDelete={() =>
                                                            requestRemoveDoc(
                                                                doc,
                                                            )
                                                        }
                                                        deleteLabel={
                                                            detachesDocument
                                                                ? "Remove from project"
                                                                : "Delete"
                                                        }
                                                        deleteDisabled={isSharedDocument(
                                                            doc,
                                                        )}
                                                    />
                                                )}
                                            </div>
                            </div>
                        </div>
                    );
                })}
                {/* Subfolders after files, sorted alphabetically */}
                {childFolders.map((folder) => {
                    const isExpanded = expandedFolderIds.has(folder.id);
                    const isRenaming = renamingFolderId === folder.id;
                    return (
                        <div key={`folder-${folder.id}`}>
                            <div
                                draggable={!isRenaming}
                                onDragStart={(e) => {
                                    if (isRenaming) {
                                        e.preventDefault();
                                        return;
                                    }
                                    e.dataTransfer.setData(
                                        "application/mike-folder",
                                        folder.id,
                                    );
                                    e.dataTransfer.effectAllowed = "move";
                                    e.stopPropagation();
                                }}
                                onDragOver={(e) => {
                                    if (!hasMovePayload(e.dataTransfer)) return;
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setDragOverFolderId(folder.id);
                                    setDragOverVersionDocId(null);
                                }}
                                onDragLeave={(e) => {
                                    e.stopPropagation();
                                    setDragOverFolderId(null);
                                }}
                                onDrop={async (e) => {
                                    if (!hasMovePayload(e.dataTransfer)) return;
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setDragOverFolderId(null);
                                    setDragOverRoot(false);
                                    setDragOverVersionDocId(null);
                                    await handleDropOnFolder(
                                        folder.id,
                                        e.dataTransfer,
                                    );
                                }}
                                onClick={() => toggleFolder(folder.id)}
                                className={`${DOCUMENT_ROW_CLASS} cursor-pointer ${isRenaming ? "" : "select-none"} ${dragOverFolderId === folder.id ? "bg-red-50 ring-1 ring-inset ring-red-200" : `bg-app-surface ${APP_SURFACE_HOVER_CLASS}`}`}
                            >
                                <div
                                    className={`sticky left-0 z-[60] ${DOC_NAME_COL_W} bg-inherit py-2 pl-4 pr-2`}
                                    style={treeNameCellStyle(depth)}
                                >
                                    <div className="flex items-center">
                                        <span className="mr-4 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                                            {isExpanded ? (
                                                <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                                            ) : (
                                                <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
                                            )}
                                        </span>
                                        <FolderSvgIcon
                                            open={isExpanded}
                                            className="mr-2 h-4 w-4 shrink-0"
                                        />
                                        {isRenaming ? (
                                            <input
                                                autoFocus
                                                className="flex-1 min-w-0 text-sm text-gray-800 bg-transparent outline-none"
                                                value={renameFolderValue}
                                                onDragStart={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                }}
                                                onChange={(e) =>
                                                    setRenameFolderValue(
                                                        e.target.value,
                                                    )
                                                }
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter")
                                                        void handleRenameFolder(
                                                            folder.id,
                                                        );
                                                    if (e.key === "Escape")
                                                        setRenamingFolderId(
                                                            null,
                                                        );
                                                }}
                                                onBlur={() =>
                                                    void handleRenameFolder(
                                                        folder.id,
                                                    )
                                                }
                                                onClick={(e) =>
                                                    e.stopPropagation()
                                                }
                                            />
                                        ) : (
                                            <span className="text-sm text-gray-800 truncate">
                                                {folder.name}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <div className={`${DOCUMENT_TYPE_COLUMN} ml-auto text-xs text-gray-300`}>
                                    —
                                </div>
                                <div className={`${DOCUMENT_SIZE_COLUMN} text-sm text-gray-300`}>
                                    —
                                </div>
                                <div className={`${DOCUMENT_VERSION_COLUMN} text-sm text-gray-300`}>
                                    —
                                </div>
                                <div className={`${DOCUMENT_CREATED_COLUMN} text-sm text-gray-300`}>
                                    —
                                </div>
                                <div className={`${DOCUMENT_UPDATED_COLUMN} text-sm text-gray-300`}>
                                    —
                                </div>
                                <div
                                    className="w-8 shrink-0 flex justify-end"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <RowActions
                                        onNewSubfolder={() => {
                                            setCreatingFolderIn(folder.id);
                                            setNewFolderName("");
                                            setExpandedFolderIds(
                                                (prev) =>
                                                    new Set([
                                                        ...prev,
                                                        folder.id,
                                                    ]),
                                            );
                                        }}
                                        newSubfolderLabel="New subfolder inside"
                                        onRename={() => {
                                            setRenameFolderValue(folder.name);
                                            setRenamingFolderId(folder.id);
                                        }}
                                        onDelete={() =>
                                            requestDeleteFolder(folder.id)
                                        }
                                    />
                                </div>
                            </div>
                            {isExpanded && renderLevel(folder.id, depth + 1)}
                        </div>
                    );
                })}
                {/* New-folder input row at the bottom of this level */}
                {!flat && renderFolderInput(parentId, depth)}
            </>
        );
    }
    const docs = documents;
    const downloadDoc = useCallback(async (docId: string) => {
        const { url, filename } = await getDocumentUrl(docId);
        downloadUrl(url, filename);
    }, []);
    const handleDownloadSelectedDocs = useCallback(async () => {
        const ids = [...selectedDocIds];
        if (ids.length === 1) {
            await downloadDoc(ids[0]);
            return;
        }
        downloadBlob(await downloadDocumentsZip(ids), "documents.zip");
    }, [downloadDoc, selectedDocIds]);
    const handleRemoveSelectedFromFolder = useCallback(async () => {
        const ids = selectedDocIds.filter(
            (id) => docs.find((d) => d.id === id)?.folder_id != null,
        );
        if (ids.length === 0) return;
        setDocuments((prev) =>
            prev.map((d) =>
                ids.includes(d.id) ? { ...d, folder_id: null } : d,
            ),
        );
        await Promise.all(
            ids.map((id) => operations.moveDocument(id, null).catch(() => {})),
        );
    }, [docs, operations, selectedDocIds, setDocuments]);
    const requestDeleteSelectedDocs = useCallback(async () => {
        const documentsToRemove = selectedDocIds
            .map((id) => documents.find((document) => document.id === id))
            .filter((document): document is Document => !!document);
        if (!documentsToRemove.length) return;
        setPendingDocumentRemoval({
            documents: documentsToRemove,
            fromSelection: true,
        });
        setDocumentRemovalStatus("idle");
    }, [documents, selectedDocIds]);
    async function confirmPendingDocumentRemoval() {
        const pending = pendingDocumentRemoval;
        if (!pending || documentRemovalStatus === "deleting") return;
        setDocumentRemovalStatus("deleting");
        try {
            await handleRemoveDocuments(
                pending.documents.map((document) => document.id),
                pending.fromSelection,
            );
            setDocumentRemovalStatus("deleted");
            window.setTimeout(() => {
                setPendingDocumentRemoval(null);
                setDocumentRemovalStatus("idle");
            }, 650);
        } catch (err) {
            if (pending.fromSelection) throw err;
            console.error("delete document failed", err);
            setDocumentRemovalStatus("idle");
            setCollectionActionWarning(
                detachesDocument
                    ? "The document could not be removed from this project. Please try again."
                    : "The document could not be deleted. Please try again.",
            );
        }
    }
    const sidePanelDoc = viewingDoc
        ? (docs.find((doc) => doc.id === viewingDoc.id) ?? viewingDoc)
        : null;
    const versionUploadAccept = ".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt";
    const q = search.toLowerCase();
    const filteredDocs = useMemo(
        () => docs.filter((doc) => !q || doc.filename.toLowerCase().includes(q)),
        [docs, q],
    );
    const allDocsSelected =
        filteredDocs.length > 0 &&
        filteredDocs.every((d) => selectedDocIds.includes(d.id));
    const someDocsSelected =
        !allDocsSelected &&
        filteredDocs.some((d) => selectedDocIds.includes(d.id));
    const selectedAutomationDocument =
        scopeKey !== "templates" && selectedDocIds.length === 1
            ? (docs.find((document) => document.id === selectedDocIds[0]) ??
              null)
            : null;
    const selectionActions = useMemo<DocTableSelectionActions | null>(() => {
        if (selectedDocIds.length === 0) return null;
        return {
            selectedCount: selectedDocIds.length,
            selectedDocuments: selectedDocIds
                .map((id) => docs.find((document) => document.id === id))
                .filter((document): document is Document => !!document),
            automationDocument: selectedAutomationDocument,
            hasDocumentsInFolders: selectedDocIds.some(
                (id) => docs.find((d) => d.id === id)?.folder_id != null,
            ),
            onAutomationDocumentChanged: async () => {
                if (!selectedAutomationDocument) return;
                await refreshDocumentVersionState(
                    selectedAutomationDocument.id,
                );
            },
            onDownload: handleDownloadSelectedDocs,
            onRemoveFromFolder: handleRemoveSelectedFromFolder,
            onDelete: requestDeleteSelectedDocs,
        };
    }, [
        docs,
        handleDownloadSelectedDocs,
        handleRemoveSelectedFromFolder,
        refreshDocumentVersionState,
        requestDeleteSelectedDocs,
        selectedAutomationDocument,
        selectedDocIds,
    ]);
    useEffect(() => {
        onSelectionActionsChange?.(selectionActions);
    }, [onSelectionActionsChange, selectionActions]);
    useEffect(() => {
        return () => onSelectionActionsChange?.(null);
    }, [onSelectionActionsChange]);
    const pendingDeleteDoc =
        pendingDocumentRemoval && !pendingDocumentRemoval.fromSelection
            ? pendingDocumentRemoval.documents[0]
            : null;
    const pendingDeleteSelection = pendingDocumentRemoval?.fromSelection
        ? pendingDocumentRemoval.documents
        : null;
    const pendingDeleteDocVersionCount = pendingDeleteDoc
        ? versionsByDocId
              .get(pendingDeleteDoc.id)
              ?.versions.filter((version) => version.deleted_at == null).length
        : undefined;
    const pendingDeleteDocName = pendingDeleteDoc ? (
        <span className="font-medium text-gray-950">
            {pendingDeleteDoc.filename}
        </span>
    ) : null;
    const pendingDeleteMessage = pendingDeleteDoc ? (
        <div className="space-y-2">
            <p>
                {detachesDocument ? (
                    <>
                        Remove{" "}
                        {pendingDeleteDocName}{" "}
                        from this project? The Library file and its links in
                        other projects will be kept.
                    </>
                ) : pendingDeleteDocVersionCount ? (
                    <>
                        {pendingDeleteDocName} has{" "}
                        {pendingDeleteDocVersionCount}{" "}
                        {pendingDeleteDocVersionCount === 1
                            ? "version"
                            : "versions"}
                        . Deleting this document will delete all of its versions.
                    </>
                ) : (
                    <>
                        Delete {pendingDeleteDocName}? This will delete the
                        document and all of its versions.
                    </>
                )}
            </p>
        </div>
    ) : pendingDeleteSelection
        ? detachesDocument
            ? `Remove ${pendingDeleteSelection.length} selected ${
                  pendingDeleteSelection.length === 1
                      ? "document"
                      : "documents"
              } from this project? The Library files and their links in other projects will be kept.`
            : `Permanently delete ${pendingDeleteSelection.length} selected ${
                  pendingDeleteSelection.length === 1
                      ? "document and all of its versions"
                      : "documents and all of their versions"
              }?`
        : undefined;
    const pendingDeleteFolderMessage = pendingDeleteFolder ? (
        <div className="space-y-2">
            <p>
                This will permanently delete{" "}
                <span className="font-medium text-gray-950">
                    {pendingDeleteFolder.folderIds.length}{" "}
                    {pendingDeleteFolder.folderIds.length === 1
                        ? "folder"
                        : "folders"}
                </span>
                , including{" "}
                <span className="font-medium text-gray-950">
                    {pendingDeleteFolder.folder.name}
                </span>
                {pendingDeleteFolder.folderIds.length > 1
                    ? " and its nested subfolders"
                    : ""}
                .
            </p>
            {pendingDeleteFolder.documentCount > 0 && (
                <p>
                    {pendingDeleteFolder.documentCount}{" "}
                    {pendingDeleteFolder.documentCount === 1
                        ? "document"
                        : "documents"}{" "}
                    in the deleted{" "}
                    {pendingDeleteFolder.folderIds.length === 1
                        ? "folder"
                        : "folders"}{" "}
                    will also be permanently deleted.
                </p>
            )}
        </div>
    ) : undefined;
    return (
        <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <input
                ref={versionUploadInputRef}
                type="file"
                accept={versionUploadAccept}
                className="hidden"
                onChange={handleVersionUploadInputChange}
            />
            <input
                ref={documentUploadInputRef}
                type="file"
                accept={SUPPORTED_DOCUMENT_ACCEPT}
                multiple
                className="hidden"
                onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    void handleDropCollectionFiles(files);
                }}
            />
            <WarningPopup
                open={!!documentUploadWarning}
                onClose={() => setDocumentUploadWarning(null)}
                message={documentUploadWarning}
            />
            <WarningPopup
                open={!!documentRenameWarning}
                onClose={() => setDocumentRenameWarning(null)}
                message={documentRenameWarning}
            />
            <WarningPopup
                open={!!collectionActionWarning}
                onClose={() => setCollectionActionWarning(null)}
                message={collectionActionWarning}
            />
            <ConfirmPopup
                open={!!pendingDocumentRemoval}
                title={
                    detachesDocument
                        ? "Remove from project?"
                        : pendingDocumentRemoval?.fromSelection
                          ? "Delete documents?"
                          : "Delete document?"
                }
                message={pendingDeleteMessage}
                confirmLabel={detachesDocument ? "Remove" : "Delete"}
                confirmStatus={
                    documentRemovalStatus === "deleting"
                        ? "loading"
                        : documentRemovalStatus === "deleted"
                          ? "complete"
                          : "idle"
                }
                cancelLabel="Cancel"
                onCancel={() => {
                    if (documentRemovalStatus === "deleting") return;
                    setPendingDocumentRemoval(null);
                    setDocumentRemovalStatus("idle");
                }}
                onConfirm={() => void confirmPendingDocumentRemoval()}
            />
            <ConfirmPopup
                open={!!pendingDeleteFolder}
                title="Delete folder?"
                message={pendingDeleteFolderMessage}
                confirmLabel="Delete"
                confirmStatus={
                    pendingDeleteFolderStatus === "deleting"
                        ? "loading"
                        : pendingDeleteFolderStatus === "deleted"
                          ? "complete"
                          : "idle"
                }
                cancelLabel="Cancel"
                onCancel={() => {
                    if (pendingDeleteFolderStatus === "deleting") return;
                    setPendingDeleteFolder(null);
                    setPendingDeleteFolderStatus("idle");
                }}
                onConfirm={() => void confirmDeletePendingFolder()}
            />
            {/* Table content */}
            <TableScrollArea
                className="document-table"
                header={
                    loading ? (
                        <ProjectTableLoadingHeader
                            stickyCellBg={stickyCellBg}
                        />
                    ) : (
                        <TableHeaderRow
                            className={`${stickyCellBg} !min-w-0 w-full pr-2`}
                        >
                            <TableStickyCell
                                header
                                widthClassName={DOC_NAME_COL_W}
                                bgClassName={stickyCellBg}
                            >
                                <CheckboxControl
                                    checked={allDocsSelected}
                                    ref={(el) => {
                                        if (el)
                                            el.indeterminate =
                                                someDocsSelected;
                                    }}
                                    onChange={() => {
                                        if (allDocsSelected)
                                            setSelectedDocIds([]);
                                        else
                                            setSelectedDocIds(
                                                filteredDocs.map((d) => d.id),
                                            );
                                    }}
                                    className="-ml-2 mr-1"
                                />
                                <span
                                    aria-hidden="true"
                                    className="mr-2 h-4 w-4 shrink-0"
                                />
                                <span className="mr-1">Name</span>
                            </TableStickyCell>
                            <TableHeaderCell className="ml-auto hidden w-20 items-center gap-1 sm:flex">
                                <span>Type</span>
                            </TableHeaderCell>
                            <TableHeaderCell className="hidden w-24 items-center gap-1 md:flex">
                                <span>Size</span>
                            </TableHeaderCell>
                            <TableHeaderCell className="flex w-20 items-center gap-1">
                                <span>Version</span>
                            </TableHeaderCell>
                            <TableHeaderCell className="hidden w-32 items-center gap-1 lg:flex">
                                <span>Created</span>
                            </TableHeaderCell>
                            <TableHeaderCell className="hidden w-32 items-center gap-1 xl:flex">
                                <span>Updated</span>
                            </TableHeaderCell>
                            <TableHeaderCell className="w-8" />
                        </TableHeaderRow>
                    )
                }
            >
                    {loading ? (
                        <ProjectTableLoading stickyCellBg={stickyCellBg} />
                    ) : (
                        <div className="flex-1 flex flex-col min-h-0">
                            <div className="flex-1 flex flex-col min-h-0 relative">
                                {dragOverRoot && dragOverFolderId === null && (
                                    <div className="absolute inset-0 border-2 border-red-400 pointer-events-none z-[80]" />                                )}
                                {/* Empty state */}
                                {docs.length === 0 &&
                                folders.length === 0 &&
                                uploadingDroppedFilenames.length === 0 ? (
                                    <div
                                        onClick={openAddDocuments}
                                        onDragOver={(e) => {
                                            if (!hasFilePayload(e.dataTransfer)) return;
                                            e.preventDefault();
                                            e.dataTransfer.dropEffect = "copy";
                                        }}
                                        onDrop={(e) => {
                                            if (!hasFilePayload(e.dataTransfer)) return;
                                            e.preventDefault();
                                            void handleDropCollectionFiles(Array.from(e.dataTransfer.files));
                                        }}
                                        className="flex-1 flex cursor-pointer flex-col items-center justify-center py-24 text-center"
                                    >
                                        <FolderSvgIcon className="mb-3 h-8 w-8 text-gray-700" />
                                        <p className="text-sm text-gray-400">
                                            {emptyDropLabel}
                                        </p>
                                    </div>
                                ) : (
                                    <div
                                        className="flex-1 flex flex-col"
                                        onDragOver={(e) => {
                                            if (hasFilePayload(e.dataTransfer)) {
                                                e.preventDefault();
                                                e.dataTransfer.dropEffect = "copy";
                                                return;
                                            }
                                            if (!hasMovePayload(e.dataTransfer))
                                                return;
                                            e.preventDefault();
                                            setDragOverRoot(true);
                                            setDragOverVersionDocId(null);
                                        }}
                                        onDragLeave={(e) => {
                                            if (
                                                !e.currentTarget.contains(
                                                    e.relatedTarget as Node,
                                                )
                                            ) {
                                                setDragOverRoot(false);
                                            }
                                        }}
                                        onDrop={async (e) => {
                                            if (hasFilePayload(e.dataTransfer)) {
                                                e.preventDefault();
                                                void handleDropCollectionFiles(Array.from(e.dataTransfer.files));
                                                return;
                                            }
                                            if (!hasMovePayload(e.dataTransfer))
                                                return;
                                            e.preventDefault();
                                            setDragOverRoot(false);
                                            setDragOverFolderId(null);
                                            setDragOverVersionDocId(null);
                                            await handleDropOnFolder(
                                                null,
                                                e.dataTransfer,
                                            );
                                        }}
                                    >
                                        {renderLevel(null, 0, Boolean(q))}
                                        {/* Spacer — fills remaining height and extends the root drop zone */}
                                        <div className="flex-1 min-h-16" />
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
            </TableScrollArea>
            {renderAddDocumentsModal?.(
                addDocsOpen,
                () => setAddDocsOpen(false),
                handleDocsSelected,
            )}
            <DocumentSidePanel
                doc={sidePanelDoc}
                versionId={viewingDocVersion?.id ?? null}
                currentVersionId={
                    sidePanelDoc
                        ? (versionsByDocId.get(sidePanelDoc.id)
                              ?.currentVersionId ?? null)
                        : null
                }
                versions={
                    sidePanelDoc
                        ? (versionsByDocId.get(sidePanelDoc.id)?.versions ?? [])
                        : []
                }
                versionsLoading={
                    sidePanelDoc
                        ? loadingVersionDocIds.has(sidePanelDoc.id)
                        : false
                }
                onClose={() => {
                    setViewingDoc(null);
                    setViewingDocVersion(null);
                }}
                onLoadVersions={(docId) => loadDocumentVersions(docId)}
                onSelectVersion={(versionId, label) =>
                    setViewingDocVersion({ id: versionId, label })
                }
                onDownloadDocument={downloadDoc}
                onDownloadVersion={downloadDocVersion}
                onRenameVersion={handleRenameVersion}
                onDeleteVersion={handleDeleteVersion}
                onUploadNewVersion={submitNewVersion}
                onReplaceVersion={replaceVersionFile}
                canDelete={!isSharedDocument(sidePanelDoc)}
                onOwnerOnlyAction={setOwnerOnlyAction}
                onDelete={async (doc) => {
                    await handleRemoveDocuments([doc.id], false);
                }}
                documentRemovalMode={documentRemovalMode}
            />
        </div>
    );
}

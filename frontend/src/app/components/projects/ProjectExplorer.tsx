"use client";
import { useEffect, useRef, useState } from "react";
import {
    ChevronRight,
    ChevronDown,
    Trash2,
} from "lucide-react";
import type {
    Document,
    Folder as ProjectFolder,
} from "@/app/components/shared/types";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import {
    FolderSvgIcon,
} from "@/app/components/shared/FolderSvgIcon";
interface Props {
    documents: Document[];
    folders?: ProjectFolder[];
    selectedDocId?: string | null;
    onDocClick: (doc: Document) => void;
    onCreateFolder?: (parentFolderId: string | null, name: string) => Promise<void>;
    onRenameFolder?: (folderId: string, name: string) => Promise<void>;
    onDeleteFolder?: (folderId: string) => Promise<void>;
    onDeleteDoc?: (docId: string) => Promise<void>;
    documentRemovalMode?: "delete" | "detach";
    onMoveDoc?: (docId: string, targetFolderId: string | null) => Promise<void>;
    onMoveFolder?: (folderId: string, targetFolderId: string | null) => Promise<void>;
}
type ContextMenuState = {    x: number;
    y: number;
    parentId: string | null;      // folder to create inside (null = root)
    folderId?: string;             // set if right-clicked on a specific folder
    docId?: string;                // set if right-clicked on a specific document
};
export function ProjectExplorer({
    documents,
    folders = [],
    selectedDocId,
    onDocClick,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onDeleteDoc,
    documentRemovalMode = "delete",
    onMoveDoc,
    onMoveFolder,
}: Props) {
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
    const [newFolderName, setNewFolderName] = useState("");
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
    const [dragOverRoot, setDragOverRoot] = useState(false);
    const [pendingDocumentId, setPendingDocumentId] = useState<string | null>(
        null,
    );
    const [documentRemovalStatus, setDocumentRemovalStatus] = useState<
        "idle" | "deleting" | "deleted"
    >("idle");
    const [documentRemovalError, setDocumentRemovalError] = useState<
        string | null
    >(null);
    const newFolderInputRef = useRef<HTMLInputElement>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!contextMenu) return;
        function handle(e: MouseEvent) {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
            }
        }
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, [contextMenu]);
    useEffect(() => {
        function handleDragEnd() {
            setDragOverFolderId(null);
            setDragOverRoot(false);
        }
        document.addEventListener("dragend", handleDragEnd);
        return () => document.removeEventListener("dragend", handleDragEnd);
    }, []);
    function toggleFolder(id: string) {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }
    async function commitNewFolder(parentId: string | null) {
        const name = newFolderName.trim();
        if (!name) return;
        setCreatingIn(undefined);
        setNewFolderName("");
        if (!onCreateFolder) return;
        await onCreateFolder(parentId, name);
        if (parentId) setExpandedIds((prev) => new Set([...prev, parentId]));
    }
    async function commitRename(folderId: string) {
        const name = renameValue.trim();
        setRenamingId(null);
        if (!name || !onRenameFolder) return;
        await onRenameFolder(folderId, name);
    }
    async function confirmDocumentRemoval() {
        if (
            !pendingDocumentId ||
            !onDeleteDoc ||
            documentRemovalStatus === "deleting"
        ) {
            return;
        }
        setDocumentRemovalStatus("deleting");
        setDocumentRemovalError(null);
        try {
            await onDeleteDoc(pendingDocumentId);
            setDocumentRemovalStatus("deleted");
            window.setTimeout(() => {
                setPendingDocumentId(null);
                setDocumentRemovalStatus("idle");
            }, 650);
        } catch {
            setDocumentRemovalStatus("idle");
            setDocumentRemovalError(
                documentRemovalMode === "detach"
                    ? "The document could not be removed from this project."
                    : "The document could not be deleted.",
            );
        }
    }
    function openContextMenu(
        e: React.MouseEvent,
        parentId: string | null,
        folderId?: string,
        docId?: string,
    ) {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, parentId, folderId, docId });
    }
    function wouldCreateCycle(movingId: string, targetId: string): boolean {
        let cur: ProjectFolder | undefined = folders.find((f) => f.id === targetId);
        while (cur) {
            if (cur.id === movingId) return true;
            if (!cur.parent_folder_id) break;
            cur = folders.find((f) => f.id === cur!.parent_folder_id);
        }
        return false;
    }
    async function handleDropOnTarget(targetFolderId: string | null, e: React.DragEvent) {
        const docId = e.dataTransfer.getData("application/mike-doc");
        const movingFolderId = e.dataTransfer.getData("application/mike-folder");
        if (docId && onMoveDoc) {
            const doc = documents.find((d) => d.id === docId);
            if (!doc || (doc.folder_id ?? null) === targetFolderId) return;
            await onMoveDoc(docId, targetFolderId);
        } else if (movingFolderId && movingFolderId !== targetFolderId && onMoveFolder) {
            if (targetFolderId !== null && wouldCreateCycle(movingFolderId, targetFolderId)) return;
            const folder = folders.find((f) => f.id === movingFolderId);
            if (!folder || (folder.parent_folder_id ?? null) === targetFolderId) return;
            await onMoveFolder(movingFolderId, targetFolderId);
        }
    }
    function isInternalDrag(e: React.DragEvent): boolean {
        return (
            Array.from(e.dataTransfer.types).includes("application/mike-doc") ||
            Array.from(e.dataTransfer.types).includes("application/mike-folder")
        );
    }
    function renderLevel(parentId: string | null, depth: number): React.ReactNode {
        const basePadding = 24 + (depth - 1) * 16;
        const childFolders = folders
            .filter((f) => f.parent_folder_id === parentId)
            .sort((a, b) => a.name.localeCompare(b.name));
        const childDocs = documents.filter((d) => (d.folder_id ?? null) === parentId);
        return (
            <>
                {/* Inline new-folder input */}
                {creatingIn === parentId && (
                    <li
                        className="flex items-center gap-1.5 py-1.5 pr-2 select-none"
                        style={{ paddingLeft: basePadding }}
                    >
                        <ChevronRight className="h-3 w-3 text-gray-300 shrink-0" />
                        <FolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                        <input
                            ref={newFolderInputRef}
                            autoFocus
                            className="flex-1 min-w-0 text-xs bg-transparent outline-none border-b border-gray-300 text-gray-800"
                            placeholder="Folder name"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void commitNewFolder(parentId);
                                if (e.key === "Escape") { setCreatingIn(undefined); setNewFolderName(""); }
                            }}
                            onBlur={() => void commitNewFolder(parentId)}
                        />
                    </li>
                )}
                {/* Child folders */}
                {childFolders.map((folder) => {
                    const isExpanded = expandedIds.has(folder.id);
                    const isRenaming = renamingId === folder.id;
                    const isDragTarget = dragOverFolderId === folder.id;
                    return (
                        <li key={`f-${folder.id}`}>
                            <div
                                draggable
                                onDragStart={(e) => {
                                    e.dataTransfer.setData("application/mike-folder", folder.id);
                                    e.dataTransfer.effectAllowed = "move";
                                    e.stopPropagation();
                                }}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setDragOverFolderId(folder.id);
                                    setDragOverRoot(false);
                                }}
                                onDragLeave={(e) => {
                                    e.stopPropagation();
                                    setDragOverFolderId(null);
                                }}
                                onDrop={async (e) => {
                                    e.preventDefault();
                                    if (isInternalDrag(e)) {
                                        e.stopPropagation();
                                        setDragOverFolderId(null);
                                        setDragOverRoot(false);
                                        await handleDropOnTarget(folder.id, e);
                                    }
                                }}
                                className={`flex items-center gap-1.5 py-1.5 pr-2 rounded-sm cursor-pointer select-none group ${
                                    isDragTarget
                                        ? "bg-red-50 ring-1 ring-inset ring-red-200"                                        : "hover:bg-gray-50"
                                }`}
                                style={{ paddingLeft: basePadding }}
                                onClick={() => toggleFolder(folder.id)}
                                onContextMenu={(e) =>
                                    openContextMenu(e, folder.id, folder.id)
                                }
                            >
                                {isExpanded
                                    ? <ChevronDown className="h-3 w-3 text-gray-400 shrink-0" />
                                    : <ChevronRight className="h-3 w-3 text-gray-400 shrink-0" />
                                }
                                <FolderSvgIcon
                                    open={isExpanded}
                                    className="h-3.5 w-3.5 shrink-0"
                                />
                                {isRenaming ? (
                                    <input
                                        autoFocus
                                        className="flex-1 min-w-0 text-xs bg-transparent outline-none border-b border-gray-300 text-gray-800"
                                        value={renameValue}
                                        onChange={(e) => setRenameValue(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") void commitRename(folder.id);
                                            if (e.key === "Escape") setRenamingId(null);
                                        }}
                                        onBlur={() => void commitRename(folder.id)}
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                ) : (
                                    <span className="text-xs text-gray-600 truncate">{folder.name}</span>
                                )}
                            </div>
                            {isExpanded && (
                                <ul>{renderLevel(folder.id, depth + 1)}</ul>
                            )}
                        </li>
                    );
                })}
                {/* Child documents */}
                {childDocs.map((doc) => {
                    const isSelected = doc.id === selectedDocId;
                    return (
                        <li
                            key={`d-${doc.id}`}
                            draggable
                            onDragStart={(e) => {
                                e.dataTransfer.setData("application/mike-doc", doc.id);
                                e.dataTransfer.effectAllowed = "move";
                            }}
                            onDragOver={(e) => e.stopPropagation()} // don't let doc rows affect root drag state
                            onClick={() => onDocClick(doc)}
                            onContextMenu={(e) =>
                                openContextMenu(
                                    e,
                                    doc.folder_id ?? null,
                                    undefined,
                                    doc.id,
                                )
                            }
                            className={`flex items-center gap-2 py-1.5 pr-4 rounded-sm cursor-pointer select-none ${
                                isSelected ? "bg-gray-100 text-gray-900" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                            }`}
                            style={{ paddingLeft: basePadding }}
                        >
                            <FileTypeIcon                                fileType={doc.file_type}                                className="h-3.5 w-3.5"                            />                            <span className="text-xs truncate">
                                {doc.filename}
                            </span>
                            {typeof doc.active_version_number === "number" &&                                Number.isFinite(doc.active_version_number) &&                                doc.active_version_number >= 1 && (                                    <span className="shrink-0 inline-flex items-center rounded-md border border-gray-200 bg-white px-1 py-0.5 text-[10px] font-medium text-gray-500">                                        V{doc.active_version_number}                                    </span>                                )}                        </li>
                    );
                })}
            </>
        );
    }
    const pendingDocument = documents.find(
        (document) => document.id === pendingDocumentId,
    );
    const detachesDocument = documentRemovalMode === "detach";
    return (
        <>
        <ul
            className={`p-1 relative h-full ${dragOverRoot && dragOverFolderId === null ? "ring-2 ring-red-400 ring-inset" : ""}`}            onContextMenu={(e) => {
                openContextMenu(e, null);
            }}
            onDragOver={(e) => {
                e.preventDefault();
                setDragOverRoot(true);
            }}
            onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDragOverRoot(false);
                }
            }}
            onDrop={async (e) => {
                e.preventDefault();
                if (isInternalDrag(e)) {
                    e.stopPropagation();
                    setDragOverRoot(false);
                    setDragOverFolderId(null);
                    await handleDropOnTarget(null, e);
                }
            }}
        >
            {/* Tree (depth 1 = direct children of root).
                Root-level new-folder input is rendered here by renderLevel
                when creatingIn === null — no separate top-level block. */}
            {renderLevel(null, 1)}
            {/* Empty state */}
            {documents.length === 0 && folders.length === 0 && creatingIn === undefined && (
                <li className="px-4 py-2 text-xs text-gray-400">No documents in this project.</li>
            )}
            {/* Context menu */}
            {contextMenu && (
                <div
                    ref={contextMenuRef}
                    className="fixed z-50 w-44 rounded-lg border border-gray-100 bg-white shadow-lg overflow-hidden text-xs"
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                    {onCreateFolder && (
                        <button
                            className="w-full px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                            onClick={() => {
                                setContextMenu(null);
                                if (contextMenu.parentId) {
                                    setExpandedIds((prev) =>
                                        new Set([...prev, contextMenu.parentId!]),
                                    );
                                }
                                setCreatingIn(contextMenu.parentId);
                                setNewFolderName("");
                            }}
                        >
                            <FolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                            New subfolder
                        </button>
                    )}
                    {contextMenu.folderId && onRenameFolder && (
                        <button
                            className="w-full px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50"
                            onClick={() => {
                                const f = folders.find((x) => x.id === contextMenu.folderId);
                                setRenameValue(f?.name ?? "");
                                setRenamingId(contextMenu.folderId!);
                                setContextMenu(null);
                            }}
                        >
                            Rename
                        </button>
                    )}
                    {contextMenu.folderId && onDeleteFolder && (
                        <button
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                            onClick={() => {
                                onDeleteFolder(contextMenu.folderId!);
                                setContextMenu(null);
                            }}
                        >
                            <Trash2 className="h-3.5 w-3.5 shrink-0" />
                            Delete folder
                        </button>
                    )}
                    {contextMenu.docId && onDeleteDoc && (
                        <button
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                            onClick={() => {
                                setPendingDocumentId(contextMenu.docId!);
                                setDocumentRemovalStatus("idle");
                                setContextMenu(null);
                            }}
                        >
                            <Trash2 className="h-3.5 w-3.5 shrink-0" />
                            {detachesDocument
                                ? "Remove from project"
                                : "Delete file"}
                        </button>
                    )}
                </div>
            )}
        </ul>
        <ConfirmPopup
            open={!!pendingDocumentId}
            title={
                detachesDocument ? "Remove from project?" : "Delete document?"
            }
            message={
                detachesDocument
                    ? `Remove ${pendingDocument?.filename ?? "this document"} from this project? The Library file and its links in other projects will be kept.`
                    : `Permanently delete ${pendingDocument?.filename ?? "this document"} and all of its versions?`
            }
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
                setPendingDocumentId(null);
                setDocumentRemovalStatus("idle");
            }}
            onConfirm={() => void confirmDocumentRemoval()}
        />
        <WarningPopup
            open={!!documentRemovalError}
            message={documentRemovalError}
            onClose={() => setDocumentRemovalError(null)}
        />
        </>
    );
}

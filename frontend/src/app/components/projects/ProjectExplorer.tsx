"use client";
import { useState, type DragEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Document, Folder } from "@/app/components/shared/types";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { RowActions } from "@/app/components/shared/RowActions";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { buildDocumentTree, DOCUMENT_DRAG_TYPE, documentTreeDropFolder,
    FOLDER_DRAG_TYPE, hasDocumentTreeDrag, wouldCreateFolderCycle } from "@/app/components/documents/documentTree";

interface Props {
    documents: Document[];
    folders?: Folder[];
    selectedDocId?: string | null;
    onDocClick: (document: Document) => void;
    onCreateFolder?: (parentId: string | null, name: string) => Promise<void>;
    onRenameFolder?: (folderId: string, name: string) => Promise<void>;
    onDeleteFolder?: (folderId: string) => Promise<void>;
    onDeleteDoc?: (documentId: string) => Promise<void>;
    documentRemovalMode?: "delete" | "detach";
    onMoveDoc?: (documentId: string, folderId: string | null) => Promise<void>;
    onMoveFolder?: (folderId: string, parentId: string | null) => Promise<void>;
}
type Editor = { kind: "new"; parentId: string | null } |
    { kind: "rename"; folderId: string };

export function ProjectExplorer({
    documents, folders = [], selectedDocId, onDocClick, onCreateFolder,
    onRenameFolder, onDeleteFolder, onDeleteDoc,
    documentRemovalMode = "delete", onMoveDoc, onMoveFolder,
}: Props) {
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [editor, setEditor] = useState<Editor | null>(null);
    const [name, setName] = useState("");
    const [dragTarget, setDragTarget] = useState<string | null>();
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [status, setStatus] = useState<"idle" | "loading" | "complete">("idle");
    const [error, setError] = useState<string | null>(null);
    const tree = buildDocumentTree(documents, folders, expanded,
        editor?.kind === "new" ? editor.parentId : undefined, "", true);
    const detaches = documentRemovalMode === "detach";
    const pending = documents.find(({ id }) => id === pendingId);
    function toggleFolder(id: string) {
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }
    function startEditor(next: Editor, value = "") {
        setEditor(next);
        setName(value);
        if (next.kind === "new" && next.parentId)
            setExpanded((current) => new Set(current).add(next.parentId!));
    }
    async function commitEditor() {
        const current = editor;
        const value = name.trim();
        setEditor(null);
        setName("");
        if (!current || !value) return;
        if (current.kind === "new") await onCreateFolder?.(current.parentId, value);
        else await onRenameFolder?.(current.folderId, value);
    }
    async function drop(event: DragEvent<HTMLUListElement>) {
        if (!hasDocumentTreeDrag(event.dataTransfer)) return;
        event.preventDefault();
        const targetId = documentTreeDropFolder(event.target);
        const documentId = event.dataTransfer.getData(DOCUMENT_DRAG_TYPE);
        const folderId = event.dataTransfer.getData(FOLDER_DRAG_TYPE);
        setDragTarget(undefined);
        if (documentId && onMoveDoc) {
            const document = documents.find(({ id }) => id === documentId);
            if (document && (document.folder_id ?? null) !== targetId)
                await onMoveDoc(documentId, targetId);
        } else if (
            folderId && onMoveFolder && folderId !== targetId &&
            (!targetId || !wouldCreateFolderCycle(folderId, targetId, tree.folderById))
        ) {
            const folder = tree.folderById.get(folderId);
            if (folder && (folder.parent_folder_id ?? null) !== targetId)
                await onMoveFolder(folderId, targetId);
        }
    }
    async function removeDocument() {
        if (!pendingId || !onDeleteDoc || status === "loading") return;
        setStatus("loading");
        setError(null);
        try {
            await onDeleteDoc(pendingId);
            setStatus("complete");
            window.setTimeout(() => {
                setPendingId(null);
                setStatus("idle");
            }, 650);
        } catch {
            setStatus("idle");
            setError(detaches ? "The document could not be removed from this project."
                : "The document could not be deleted.");
        }
    }
    return (
        <>
            <div className="flex h-full min-h-0 flex-col">
                {onCreateFolder && (
                    <button type="button" onClick={() =>
                        startEditor({ kind: "new", parentId: null })}
                        className="mx-2 my-1 flex h-8 shrink-0 items-center gap-2 rounded px-2 text-xs font-medium text-gray-700 hover:bg-gray-100">
                        <FolderSvgIcon className="h-3.5 w-3.5" /> New folder
                    </button>
                )}
                <ul
                    className={`min-h-0 flex-1 overflow-y-auto p-1 ${dragTarget === null ? "ring-1 ring-inset ring-red-200" : ""}`}
                    onDragOver={(event) => {
                        if (!hasDocumentTreeDrag(event.dataTransfer)) return;
                        event.preventDefault();
                        setDragTarget(documentTreeDropFolder(event.target));
                    }}
                    onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node))
                            setDragTarget(undefined);
                    }}
                    onDragEnd={() => setDragTarget(undefined)}
                    onDrop={(event) => void drop(event)}>
                    {tree.rows.map((row) => {
                        if (row.kind === "editor") return (
                            <li key={`editor-${row.parentId ?? "root"}`} data-tree-drop-folder={row.parentId ?? ""}
                                className="flex h-9 items-center gap-1.5 pr-2"
                                style={{ paddingLeft: 8 + row.depth * 16 }}>
                                <ChevronRight className="h-3 w-3 shrink-0 text-gray-300" />
                                <FolderSvgIcon className="h-3.5 w-3.5 shrink-0" />
                                <NameInput value={name} onChange={setName} onCommit={() =>
                                    void commitEditor()} onCancel={() => setEditor(null)} />
                            </li>
                        );
                        if (row.kind === "folder") {
                            const folder = row.folder;
                            const open = expanded.has(folder.id);
                            const renaming = editor?.kind === "rename" &&
                                editor.folderId === folder.id;
                            return (
                                <li key={folder.id} data-tree-drop-folder={folder.id}
                                    draggable={!renaming}
                                    onDragStart={(event) => {
                                        event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id);
                                        event.dataTransfer.effectAllowed = "move";
                                    }}
                                    className={`flex h-9 min-w-0 items-center ${dragTarget === folder.id ? "bg-red-50 ring-1 ring-inset ring-red-200" : "hover:bg-gray-50"}`}
                                    style={{ paddingLeft: 8 + row.depth * 16 }}>
                                    <button type="button"
                                        onClick={() => toggleFolder(folder.id)}
                                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                        {open
                                            ? <ChevronDown className="h-3 w-3 shrink-0 text-gray-500" />
                                            : <ChevronRight className="h-3 w-3 shrink-0 text-gray-500" />}
                                        <FolderSvgIcon open={open} className="h-3.5 w-3.5 shrink-0" />
                                        {renaming ? (
                                            <NameInput value={name} onChange={setName}
                                                onCommit={() => void commitEditor()}
                                                onCancel={() => setEditor(null)} />
                                        ) : (
                                            <span className="truncate text-xs text-gray-700">{folder.name}</span>
                                        )}
                                    </button>
                                    <RowActions
                                        onNewSubfolder={() =>
                                            startEditor({ kind: "new", parentId: folder.id })}
                                        onRename={() => startEditor(
                                            { kind: "rename", folderId: folder.id }, folder.name)}
                                        onDelete={onDeleteFolder
                                            ? () => void onDeleteFolder(folder.id) : undefined}
                                    />
                                </li>
                            );
                        }
                        const document = row.document;
                        return (
                            <li key={document.id}
                                data-tree-drop-folder={row.parentId ?? ""} draggable
                                onDragStart={(event) => {
                                    event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, document.id);
                                    event.dataTransfer.effectAllowed = "move";
                                }}
                                className={`flex h-9 min-w-0 items-center pr-1 ${
                                    document.id === selectedDocId
                                        ? "bg-gray-100" : "hover:bg-gray-50"}`}
                                style={{ paddingLeft: 24 + row.depth * 16 }}>
                                <button type="button" onClick={() => onDocClick(document)}
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left">
                                    <FileTypeIcon fileType={document.file_type} className="h-3.5 w-3.5 shrink-0" />
                                    <span className="min-w-0 flex-1 truncate text-xs text-gray-700">{document.filename}</span>
                                    {!!document.active_version_number && (
                                        <span className="shrink-0 text-[10px] text-gray-500">V{document.active_version_number}</span>
                                    )}
                                </button>
                                {onDeleteDoc && (
                                    <RowActions onDelete={() => setPendingId(document.id)}
                                        deleteLabel={detaches
                                            ? "Remove from project" : "Delete file"} />
                                )}
                            </li>
                        );
                    })}
                    {!documents.length && !folders.length && !editor && (
                        <li className="px-3 py-2 text-xs text-gray-500">No documents</li>
                    )}
                </ul>
            </div>
            <ConfirmPopup open={!!pendingId} title={detaches
                ? "Remove from project?" : "Delete document?"}
                message={detaches
                    ? `Remove ${pending?.filename ?? "this document"} from this project? The Library file and its links in other projects will be kept.`
                    : `Permanently delete ${pending?.filename ?? "this document"} and all of its versions?`}
                confirmLabel={detaches ? "Remove" : "Delete"} confirmStatus={status} cancelLabel="Cancel"
                onCancel={() => status !== "loading" && setPendingId(null)}
                onConfirm={() => void removeDocument()} />
            <WarningPopup open={!!error} message={error} onClose={() => setError(null)} />
        </>
    );
}

type NameInputProps = { value: string; onChange: (value: string) => void;
    onCommit: () => void; onCancel: () => void };
function NameInput({ value, onChange, onCommit, onCancel }: NameInputProps) {
    return (
        <input autoFocus aria-label="Folder name" placeholder="Folder name"
            value={value} onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") onCommit();
                else if (event.key === "Escape") onCancel();
            }}
            onBlur={onCommit} onClick={(event) => event.stopPropagation()}
            className="min-w-0 flex-1 border-b border-gray-400 bg-transparent text-xs outline-none"
        />
    );
}

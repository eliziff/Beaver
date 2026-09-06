"use client";
import { useState, type DragEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Document, Folder } from "@/app/lib/api/documents";
import { DocumentResultRow } from "@/app/components/shared/DocumentResultRow";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { RowActions } from "@/app/components/shared/RowActions";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
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
type PendingMove = { kind: "document" | "folder"; id: string };

export function ProjectExplorer({
    documents, folders = [], selectedDocId, onDocClick, onCreateFolder,
    onRenameFolder, onDeleteFolder, onDeleteDoc,
    documentRemovalMode = "delete", onMoveDoc, onMoveFolder,
}: Props) {
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [editor, setEditor] = useState<Editor | null>(null);
    const [name, setName] = useState("");
    const [dragTarget, setDragTarget] = useState<string | null>();
    const [pendingDelete, setPendingDelete] = useState<{ kind: "document" | "folder"; id: string } | null>(null);
    const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
    const [status, setStatus] = useState<"idle" | "loading" | "complete">("idle");
    const [error, setError] = useState<string | null>(null);
    const tree = buildDocumentTree(documents, folders, expanded,
        editor?.kind === "new" ? editor.parentId : undefined, "", true);
    const detaches = documentRemovalMode === "detach";
    const pendingDocument = pendingDelete?.kind === "document"
        ? documents.find(({ id }) => id === pendingDelete.id) : undefined;
    const pendingFolder = pendingDelete?.kind === "folder"
        ? folders.find(({ id }) => id === pendingDelete.id) : undefined;
    const movingDocument = pendingMove?.kind === "document"
        ? documents.find(({ id }) => id === pendingMove.id) : undefined;
    const movingFolder = pendingMove?.kind === "folder"
        ? folders.find(({ id }) => id === pendingMove.id) : undefined;
    const currentMoveParent = movingDocument?.folder_id ?? movingFolder?.parent_folder_id ?? null;
    const folderOptions = [
        ...(currentMoveParent ? [{ value: null, label: "Project root" }] : []),
        ...folders.filter((folder) => folder.id !== currentMoveParent &&
            (pendingMove?.kind !== "folder" || folder.id !== pendingMove.id &&
                !wouldCreateFolderCycle(pendingMove.id, folder.id, tree.folderById)))
            .map((folder) => ({ value: folder.id, label: folderPath(folder, tree.folderById) }))
            .sort((a, b) => a.label.localeCompare(b.label)),
    ];
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
    async function removePending() {
        if (!pendingDelete || status === "loading") return;
        const remove = pendingDelete.kind === "folder" ? onDeleteFolder : onDeleteDoc;
        if (!remove) return;
        setStatus("loading");
        setError(null);
        try {
            await remove(pendingDelete.id);
            setStatus("complete");
            window.setTimeout(() => {
                setPendingDelete(null);
                setStatus("idle");
            }, 650);
        } catch {
            setStatus("idle");
            setError(pendingDelete.kind === "folder" ? "The folder could not be deleted."
                : detaches ? "The document could not be removed from this project."
                : "The document could not be deleted.");
        }
    }
    async function movePending(destinationId: string | null) {
        const current = pendingMove;
        setPendingMove(null);
        if (!current) return;
        try {
            if (current.kind === "document") await onMoveDoc?.(current.id, destinationId);
            else await onMoveFolder?.(current.id, destinationId);
        } catch {
            setError(`${current.kind === "folder" ? "The folder" : "The document"} could not be moved.`);
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
                            const prefix = <>{open
                                ? <ChevronDown className="h-3 w-3 shrink-0 text-gray-500" aria-hidden="true" />
                                : <ChevronRight className="h-3 w-3 shrink-0 text-gray-500" aria-hidden="true" />}
                                <FolderSvgIcon open={open} className="h-3.5 w-3.5 shrink-0" /></>;
                            return (
                                <li key={folder.id} data-tree-drop-folder={folder.id}
                                    draggable={!!onMoveFolder && !renaming}
                                    onDragStart={(event) => {
                                        event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id);
                                        event.dataTransfer.effectAllowed = "move";
                                    }}
                                    className={`flex h-9 min-w-0 items-center ${dragTarget === folder.id ? "bg-red-50 ring-1 ring-inset ring-red-200" : "hover:bg-gray-50"}`}
                                    style={{ paddingLeft: 8 + row.depth * 16 }}>
                                    {renaming ? <>{prefix}
                                        <NameInput label={`Rename ${folder.name}`} value={name} onChange={setName}
                                            onCommit={() => void commitEditor()}
                                            onCancel={() => setEditor(null)} />
                                    </> : <button type="button" onClick={() => toggleFolder(folder.id)}
                                        aria-expanded={open}
                                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900">
                                        {prefix}
                                        <span className="truncate text-xs text-gray-700">{folder.name}</span>
                                    </button>}
                                    {(onCreateFolder || onRenameFolder || onMoveFolder || onDeleteFolder) && <RowActions
                                        onNewSubfolder={onCreateFolder ? () =>
                                            startEditor({ kind: "new", parentId: folder.id })
                                            : undefined}
                                        onRename={onRenameFolder ? () => startEditor(
                                            { kind: "rename", folderId: folder.id }, folder.name) : undefined}
                                        onMove={onMoveFolder ? () => setPendingMove({ kind: "folder",
                                            id: folder.id }) : undefined}
                                        onDelete={onDeleteFolder ? () =>
                                            setPendingDelete({ kind: "folder", id: folder.id }) : undefined}
                                    />}
                                </li>
                            );
                        }
                        if (row.kind === "more") return null;
                        const document = row.document;
                        return (
                            <li key={document.id}
                                data-tree-drop-folder={row.parentId ?? ""} draggable={!!onMoveDoc}
                                onDragStart={(event) => {
                                    event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, document.id);
                                    event.dataTransfer.effectAllowed = "move";
                                }}
                                className={`flex h-9 min-w-0 items-center pr-1 ${
                                    document.id === selectedDocId
                                        ? "bg-gray-100" : "hover:bg-gray-50"}`}
                                style={{ paddingLeft: 24 + row.depth * 16 }}>
                                <DocumentResultRow compact filename={document.filename.replace(/\.research\.md$/iu, "")}
                                    fileType={document.file_type} onClick={() => onDocClick(document)}
                                    className="min-w-0 flex-1"
                                    trailing={document.active_version_number
                                        ? <span className="text-[10px] text-gray-500">V{document.active_version_number}</span> : null} />
                                {(onDeleteDoc || onMoveDoc) && (
                                    <RowActions onMove={onMoveDoc ? () => setPendingMove({ kind: "document",
                                        id: document.id }) : undefined}
                                        onDelete={onDeleteDoc ? () => setPendingDelete({ kind: "document", id: document.id }) : undefined}
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
            <ConfirmPopup open={!!pendingDelete} title={pendingDelete?.kind === "folder"
                ? "Delete folder?" : detaches ? "Remove from project?" : "Delete document?"}
                message={pendingDelete?.kind === "folder"
                    ? `Permanently delete ${pendingFolder?.name ?? "this folder"} and everything inside it?`
                    : detaches ? `Remove ${pendingDocument?.filename.replace(/\.research\.md$/iu, "") ?? "this document"} from this project? The Library file and its links in other projects will be kept.`
                    : `Permanently delete ${pendingDocument?.filename.replace(/\.research\.md$/iu, "") ?? "this document"} and all of its versions?`}
                confirmLabel={detaches && pendingDelete?.kind === "document" ? "Remove" : "Delete"}
                confirmStatus={status} cancelLabel="Cancel"
                onCancel={() => status !== "loading" && setPendingDelete(null)}
                onConfirm={() => void removePending()} />
            <SearchableChoiceModal open={!!pendingMove} title={`Move ${
                movingDocument?.filename.replace(/\.research\.md$/iu, "") ?? movingFolder?.name ?? "item"}`}
                searchLabel="Search folders" value={currentMoveParent} options={folderOptions}
                onClose={() => setPendingMove(null)} onChange={(destination) =>
                    void movePending(destination)} />
            <WarningPopup open={!!error} message={error} onClose={() => setError(null)} />
        </>
    );
}

type NameInputProps = { value: string; label?: string; onChange: (value: string) => void;
    onCommit: () => void; onCancel: () => void };
function NameInput({ value, label = "Folder name", onChange, onCommit, onCancel }: NameInputProps) {
    return (
        <input autoFocus aria-label={label} placeholder="Folder name"
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

function folderPath(folder: Folder, folderById: Map<string, Folder>) {
    const names = [folder.name], seen = new Set([folder.id]);
    let parentId = folder.parent_folder_id;
    while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = folderById.get(parentId);
        if (!parent) break;
        names.unshift(parent.name);
        parentId = parent.parent_folder_id;
    }
    return names.join(" / ");
}

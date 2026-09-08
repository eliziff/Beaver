import { useCallback, useState } from "react";
import type { Document } from "@/app/lib/api/documents";
import { buildDocumentTree, documentTreeDrag, documentTreeMoveParent,
    type DocumentTreeFolder, type DocumentTreeMove } from "./documentTree";

type Editor = { kind: "new"; parentId: string | null } | { kind: "rename"; folderId: string };
type Move = (id: string, destination: string | null, parent: string | null) => Promise<unknown>;
export function useFolderInteractions({ documents, folders, search = "", foldersFirst = false,
    hasMoreParents, onFolderExpanded, onCreateFolder, onRenameFolder, onMoveDocument, onMoveFolder }: {
    documents: Document[]; folders: DocumentTreeFolder[]; search?: string; foldersFirst?: boolean;
    hasMoreParents?: Set<string | null>; onFolderExpanded?: (id: string) => void;
    onCreateFolder?: (parent: string | null, name: string) => Promise<{ id: string } | void>;
    onRenameFolder?: (id: string, name: string) => Promise<unknown>;
    onMoveDocument?: Move; onMoveFolder?: Move;
}) {
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [editor, setEditor] = useState<Editor | null>(null);
    const [dragTarget, setDragTarget] = useState<string | null>();
    const tree = buildDocumentTree(documents, folders, expanded,
        editor?.kind === "new" ? editor.parentId : undefined, search, foldersFirst, hasMoreParents);
    function toggleFolder(id: string) {
        if (!expanded.has(id)) onFolderExpanded?.(id);
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }
    const startEditor = useCallback((next: Editor) => {
        setEditor(next);
        if (next.kind === "new" && next.parentId)
            setExpanded((current) => new Set(current).add(next.parentId!));
    }, []);
    async function commitEditor(value: string) {
        const current = editor, name = value.trim();
        setEditor(null);
        if (!current || !name) return;
        if (current.kind === "rename") await onRenameFolder?.(current.folderId, name);
        else {
            const created = await onCreateFolder?.(current.parentId, name);
            if (created) setExpanded((current) => new Set(current).add(created.id));
        }
    }
    function canMove(item: DocumentTreeMove, destination: string | null) {
        return documentTreeMoveParent(item, destination, documents, tree.folderById) !== undefined;
    }
    async function move(item: DocumentTreeMove, destination: string | null) {
        const parent = documentTreeMoveParent(item, destination, documents, tree.folderById);
        if (parent === undefined) return;
        await (item.kind === "document" ? onMoveDocument : onMoveFolder)?.(item.id, destination, parent);
    }
    async function drop(data: DataTransfer, destination: string | null) {
        setDragTarget(undefined);
        const item = documentTreeDrag(data);
        if (item) await move(item, destination);
    }
    return { tree, expanded, setExpanded, editor, setEditor, startEditor, commitEditor,
        toggleFolder, dragTarget, setDragTarget, canMove, move, drop };
}

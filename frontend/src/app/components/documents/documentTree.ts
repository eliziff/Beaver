import type { Document, Folder, LibraryFolder } from "@/app/components/shared/types";

type DocumentTreeFolder = Folder | LibraryFolder;
type DocumentTreeRow = { kind: "document"; document: Document; parentId: string | null; depth: number }
    | { kind: "folder"; folder: DocumentTreeFolder; parentId: string | null; depth: number }
    | { kind: "editor"; parentId: string | null; depth: number };

export const DOCUMENT_DRAG_TYPE = "application/mike-doc";
export const FOLDER_DRAG_TYPE = "application/mike-folder";

export function buildDocumentTree(documents: Document[], folders: DocumentTreeFolder[],
    expanded: Set<string>, editorParent?: string | null, search = "", foldersFirst = false) {
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    const foldersByParent = new Map<string | null, DocumentTreeFolder[]>();
    const docsByParent = new Map<string | null, Document[]>();
    for (const folder of folders) {
        const parent = folder.parent_folder_id ?? null;
        const siblings = foldersByParent.get(parent);
        if (siblings) siblings.push(folder); else foldersByParent.set(parent, [folder]);
    }
    for (const siblings of foldersByParent.values())
        siblings.sort((a, b) => a.name.localeCompare(b.name));
    for (const document of documents) {
        const parent = document.folder_id ?? null;
        const siblings = docsByParent.get(parent);
        if (siblings) siblings.push(document); else docsByParent.set(parent, [document]);
    }
    const query = search.trim().toLocaleLowerCase();
    const visibleDocuments = query ? documents.filter(({ filename }) =>
        filename.toLocaleLowerCase().includes(query)) : documents;
    const rows: DocumentTreeRow[] = [];
    function append(parentId: string | null, depth: number) {
        const addDocuments = () => {
            for (const document of docsByParent.get(parentId) ?? [])
                rows.push({ kind: "document", document, parentId, depth });
        };
        const addFolders = () => {
            for (const folder of foldersByParent.get(parentId) ?? []) {
                rows.push({ kind: "folder", folder, parentId, depth });
                if (expanded.has(folder.id)) append(folder.id, depth + 1);
            }
        };
        if (foldersFirst && editorParent === parentId) rows.push({ kind: "editor", parentId, depth });
        if (foldersFirst) { addFolders(); addDocuments(); } else { addDocuments(); addFolders(); }
        if (!foldersFirst && editorParent === parentId) rows.push({ kind: "editor", parentId, depth });
    }
    if (query) for (const document of visibleDocuments)
        rows.push({ kind: "document", document, parentId: null, depth: 0 });
    else append(null, 0);
    return { rows, visibleDocuments, folderById, foldersByParent };
}

export function descendantFolderIds(rootId: string,
    foldersByParent: Map<string | null, DocumentTreeFolder[]>) {
    const found = new Set<string>();
    const pending = [rootId];
    while (pending.length) {
        const id = pending.pop()!;
        if (found.has(id)) continue;
        found.add(id);
        pending.push(...(foldersByParent.get(id) ?? []).map(({ id }) => id));
    }
    return found;
}

export function wouldCreateFolderCycle(movingId: string, targetId: string,
    folderById: Map<string, DocumentTreeFolder>) {
    let folder = folderById.get(targetId);
    while (folder) {
        if (folder.id === movingId) return true;
        folder = folder.parent_folder_id ? folderById.get(folder.parent_folder_id) : undefined;
    }
    return false;
}

export function hasDocumentTreeDrag({ types }: DataTransfer) {
    return Array.from(types).some((type) =>
        type === DOCUMENT_DRAG_TYPE || type === FOLDER_DRAG_TYPE);
}

export function documentTreeDropFolder(target: EventTarget | null) {
    const element = target instanceof Element ? target : null;
    return element?.closest<HTMLElement>("[data-tree-drop-folder]")
        ?.dataset.treeDropFolder || null;
}

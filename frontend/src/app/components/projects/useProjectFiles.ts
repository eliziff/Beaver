import { useCallback, useMemo, type SetStateAction } from "react";
import {
    createProjectFolder, deleteProjectFolder, moveDocumentToFolder,
    moveSubfolderToFolder, removeProjectDocument, renameProjectDocument,
    renameProjectFolder, uploadProjectDocument,
} from "@/app/lib/beaverApi";
import type { Document, Folder } from "@/app/components/shared/types";
import { descendantFolderIds } from "@/app/components/documents/documentTree";
import { useProjectWorkspace } from "./ProjectWorkspace";

function apply<T>(update: SetStateAction<T[]>, current: T[]) {
    return typeof update === "function" ? update(current) : update;
}

export function useProjectFiles() {
    const { projectId, project, setProject, refreshProject } = useProjectWorkspace();
    const documents = project?.documents ?? [];
    const folders = project?.folders ?? [];
    const setDocuments = useCallback(
        (update: SetStateAction<Document[]>) =>
            setProject((current) => current ? {
                ...current, documents: apply(update, current.documents ?? []),
            } : current),
        [setProject],
    );
    const setFolders = useCallback(
        (update: SetStateAction<Folder[]>) =>
            setProject((current) => current ? {
                ...current, folders: apply(update, current.folders ?? []),
            } : current),
        [setProject],
    );
    const operations = useMemo(
        () => ({
            removeDocument: (id: string) => removeProjectDocument(projectId, id),
            uploadDocument: (file: File) => uploadProjectDocument(projectId, file),
            refreshCollection: refreshProject,
            createFolder: (name: string, parent?: string | null) =>
                createProjectFolder(projectId, name, parent),
            renameFolder: (id: string, name: string) =>
                renameProjectFolder(projectId, id, name),
            deleteFolder: (id: string) => deleteProjectFolder(projectId, id),
            moveFolder: (id: string, parent: string | null) =>
                moveSubfolderToFolder(projectId, id, parent),
            moveDocument: (id: string, folder: string | null) =>
                moveDocumentToFolder(projectId, id, folder),
            renameDocument: (id: string, filename: string) =>
                renameProjectDocument(projectId, id, filename),
        }),
        [projectId, refreshProject],
    );
    async function uploadFiles(files: File[]) {
        const added = await Promise.all(files.map(operations.uploadDocument));
        setDocuments((current) => [...current, ...added]);
        return added;
    }
    async function createFolder(parentId: string | null, name: string) {
        const folder = await operations.createFolder(name, parentId);
        setFolders((current) => [...current, folder]);
    }
    async function renameFolder(folderId: string, name: string) {
        const updated = await operations.renameFolder(folderId, name);
        setFolders((current) =>
            current.map((folder) => (folder.id === folderId ? updated : folder)),
        );
    }
    async function deleteFolder(folderId: string) {
        const children = new Map<string | null, Folder[]>();
        for (const folder of folders) {
            const parent = folder.parent_folder_id ?? null;
            const siblings = children.get(parent);
            if (siblings) siblings.push(folder); else children.set(parent, [folder]);
        }
        const removed = descendantFolderIds(folderId, children);
        await operations.deleteFolder(folderId);
        setFolders((current) => current.filter(({ id }) => !removed.has(id)));
        setDocuments((current) =>
            current.filter(({ folder_id }) => !folder_id || !removed.has(folder_id)),
        );
    }
    async function moveDocument(id: string, folderId: string | null) {
        const updated = await operations.moveDocument(id, folderId);
        setDocuments((current) =>
            current.map((document) => (document.id === id ? updated : document)),
        );
    }
    async function moveFolder(id: string, parentId: string | null) {
        const updated = await operations.moveFolder(id, parentId);
        setFolders((current) =>
            current.map((folder) => (folder.id === id ? updated : folder)),
        );
    }
    async function deleteDocument(id: string) {
        await operations.removeDocument(id);
        setDocuments((current) => current.filter((document) => document.id !== id));
    }
    return {
        documents, folders, setDocuments, setFolders, operations, uploadFiles,
        createFolder, renameFolder, deleteFolder, moveDocument, moveFolder,
        deleteDocument,
    };
}

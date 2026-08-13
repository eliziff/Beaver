import { useMemo } from "react";
import {
    createProjectFolder, deleteProjectFolder, getProjectDirectory,
    moveDocumentToFolder, moveSubfolderToFolder, removeProjectDocument,
    renameProjectDocument, renameProjectFolder, uploadProjectDocument,
} from "@/app/lib/beaverApi";
import type { Folder } from "@/app/components/shared/types";
import { usePagedDirectory } from "@/app/hooks/usePagedDirectory";
import { useProjectWorkspace } from "./ProjectWorkspace";

export function useProjectFiles() {
    const { projectId, project, search } = useProjectWorkspace();
    const directory = usePagedDirectory(
        (parentId, q, cursor, signal) => getProjectDirectory(projectId, {
            parent_id: parentId, q, cursor,
        }, signal),
        search, [projectId, search], project != null,
    );
    const folders = directory.folders as Folder[];
    const reload = (...parents: (string | null | undefined)[]) => Promise.all(
        [...new Set(parents.map((id) => id ?? null))].map(directory.reload),
    );
    const operations = useMemo(() => ({
        removeDocument: (id: string) => removeProjectDocument(projectId, id),
        uploadDocument: (file: File) => uploadProjectDocument(projectId, file),
        refreshCollection: directory.reload,
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
    }), [directory.reload, projectId]);
    return {
        documents: directory.documents,
        folders,
        operations,
        uploadFiles: async (files: File[]) => {
            const added = await Promise.all(files.map(operations.uploadDocument));
            await reload(null);
            return added;
        },
        createFolder: async (parent: string | null, name: string) => {
            await operations.createFolder(name, parent); await reload(parent);
        },
        renameFolder: async (id: string, name: string) => {
            await operations.renameFolder(id, name);
            await reload(folders.find((item) => item.id === id)?.parent_folder_id);
        },
        deleteFolder: async (id: string) => {
            const parent = folders.find((item) => item.id === id)?.parent_folder_id;
            await operations.deleteFolder(id); await reload(parent);
        },
        moveDocument: async (id: string, parent: string | null) => {
            const old = directory.documents.find((item) => item.id === id)?.folder_id;
            await operations.moveDocument(id, parent); await reload(old, parent);
        },
        moveFolder: async (id: string, parent: string | null) => {
            const old = folders.find((item) => item.id === id)?.parent_folder_id;
            await operations.moveFolder(id, parent); await reload(old, parent);
        },
        deleteDocument: async (id: string) => {
            const parent = directory.documents.find((item) => item.id === id)?.folder_id;
            await operations.removeDocument(id); await reload(parent);
        },
        loading: directory.loading,
        hasMoreParents: directory.hasMoreParents,
        loadingParents: directory.loadingParents,
        onFolderExpanded: directory.ensureParent,
        onLoadMore: directory.loadMore,
    };
}

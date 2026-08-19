import { useMemo } from "react";
import {
    directoryResource,
    removeProjectDocument,
} from "@/app/lib/beaverApi";
import type { Folder } from "@/app/components/shared/types";
import { usePagedDirectory } from "@/app/hooks/usePagedDirectory";
import { useProjectWorkspace } from "./ProjectWorkspace";

export function useProjectFiles() {
    const { projectId, project, search } = useProjectWorkspace();
    const resource = useMemo(
        () => directoryResource({ projectId }),
        [projectId],
    );
    const directory = usePagedDirectory(
        (parentId, q, cursor, signal) => resource.list({
            parent_id: parentId, q, cursor,
        }, signal),
        search, [resource, search], project != null,
    );
    const folders = directory.folders as Folder[];
    const reload = (...parents: (string | null | undefined)[]) => Promise.all(
        [...new Set(parents.map((id) => id ?? null))].map(directory.reload),
    );
    const operations = useMemo(() => ({
        ...resource,
        removeDocument: (id: string) => removeProjectDocument(projectId, id),
        refreshCollection: directory.reload,
    }), [directory.reload, projectId, resource]);
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

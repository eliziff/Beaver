"use client";

import {
    type Dispatch,
    type SetStateAction,
    useCallback,
    useEffect,
    useMemo,
    useState,
} from "react";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import {
    createProjectFolder,
    deleteProjectFolder,
    getProject,
    moveDocumentToFolder,
    moveSubfolderToFolder,
    renameProjectDocument,
    renameProjectFolder,
    removeProjectDocument,
    uploadProjectDocument,
} from "@/app/lib/beaverApi";
import { isAnonymousMode } from "@/app/lib/authMode";
import type { Document } from "@/app/components/shared/types";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import {
    DocTable,
    type DocTableSelectionActions,
    type DocTableFolder,
} from "@/app/components/documents/DocTable";
import { DocumentAutomation } from "@/app/components/documents/DocumentAutomation";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { NativeActionSelect } from "@/app/components/ui/native-action-select";
import { ProjectSectionToolbar, useProjectWorkspace } from "./ProjectWorkspace";

interface Props {
    projectId: string;
}

export function ProjectDocumentsView({ projectId }: Props) {
    const workspace = useProjectWorkspace();
    const {
        project,
        setProject,
        folders,
        setFolders,
        projectLoading,
        prefetchProjectSections,
        search,
        setOwnerOnlyAction,
    } = workspace;
    const [createFolderAction, setCreateFolderAction] = useState<
        (() => void) | null
    >(null);
    const [selectionActions, setSelectionActions] =
        useState<DocTableSelectionActions | null>(null);

    useEffect(() => {
        if (!projectLoading) prefetchProjectSections();
    }, [projectLoading, prefetchProjectSections]);

    const documents = project?.documents ?? [];
    const setDocuments = useCallback(
        (update: SetStateAction<Document[]>) => {
            setProject((prev) => {
                if (!prev) return prev;
                const nextDocuments =
                    typeof update === "function"
                        ? update(prev.documents ?? [])
                        : update;
                return { ...prev, documents: nextDocuments };
            });
        },
        [setProject],
    );

    const refreshCollection = useCallback(async () => {
        const updated = await getProject(projectId);
        setProject(updated);
        setFolders(updated.folders ?? []);
    }, [projectId, setFolders, setProject]);
    const operations = useMemo(
        () => ({
            removeDocument: (documentId: string) =>
                removeProjectDocument(projectId, documentId),
            uploadDocument: (file: File) =>
                uploadProjectDocument(projectId, file),
            refreshCollection,
            createFolder: (name: string, parentFolderId?: string | null) =>
                createProjectFolder(projectId, name, parentFolderId),
            renameFolder: (folderId: string, name: string) =>
                renameProjectFolder(projectId, folderId, name),
            deleteFolder: (folderId: string) =>
                deleteProjectFolder(projectId, folderId),
            moveFolder: (folderId: string, parentFolderId: string | null) =>
                moveSubfolderToFolder(projectId, folderId, parentFolderId),
            moveDocument: (documentId: string, folderId: string | null) =>
                moveDocumentToFolder(projectId, documentId, folderId),
            renameDocument: (documentId: string, filename: string) =>
                renameProjectDocument(projectId, documentId, filename),
        }),
        [projectId, refreshCollection],
    );

    const handleCreateFolderActionChange = useCallback(
        (action: (() => void) | null) => {
            setCreateFolderAction(() => action);
        },
        [],
    );
    const handleSelectionActionsChange = useCallback(
        (actions: DocTableSelectionActions | null) => {
            setSelectionActions(actions);
        },
        [],
    );

    const toolbarActions = (
        <div className="flex items-center gap-1.5">
            <DocumentAutomation
                document={selectionActions?.automationDocument ?? null}
                showWhenUnavailable
                onDocumentChanged={
                    selectionActions?.onAutomationDocumentChanged
                }
            />
            <span className="inline-flex h-8 w-[5.5rem]">
                {selectionActions && (
                    <NativeActionSelect
                        label="Actions"
                        items={[
                            {
                                label: "Download",
                                onSelect: () =>
                                    void selectionActions.onDownload(),
                            },
                            ...(selectionActions.hasDocumentsInFolders
                                ? [
                                      {
                                          label: "Remove from subfolder",
                                          onSelect: () =>
                                              void selectionActions.onRemoveFromFolder(),
                                      },
                                  ]
                                : []),
                            {
                                label: isAnonymousMode ? "Remove" : "Delete",
                                onSelect: () => void selectionActions.onDelete(),
                            },
                        ]}
                        className="w-full"
                        triggerClassName="h-8 w-full items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 text-sm font-medium text-gray-800 hover:bg-gray-100 hover:text-gray-950"
                    >
                        Actions
                        <span aria-hidden="true">&#9662;</span>
                    </NativeActionSelect>
                )}
            </span>
            <TabPillButton
                onClick={createFolderAction ?? undefined}
                disabled={!createFolderAction || projectLoading}
            >
                <FolderSvgIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Folder</span>
            </TabPillButton>
        </div>
    );

    if (!projectLoading && !project) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-gray-400">Project not found</p>
            </div>
        );
    }

    return (
        <>
            <ProjectSectionToolbar actions={toolbarActions} />
            <DocTable
                scopeKey={projectId}
                documents={documents}
                setDocuments={setDocuments}
                folders={folders}
                setFolders={
                    setFolders as Dispatch<SetStateAction<DocTableFolder[]>>
                }
                loading={projectLoading}
                search={search}
                operations={operations}
                onAddDocumentsActionChange={
                    workspace.setAddDocumentsHeaderAction
                }
                onCreateFolderActionChange={handleCreateFolderActionChange}
                onSelectionActionsChange={handleSelectionActionsChange}
                renderAddDocumentsModal={(open, onClose, onSelect) =>
                    project ? (
                        <AddDocumentsModal
                            open={open}
                            onClose={onClose}
                            onSelect={onSelect}
                            breadcrumb={[
                                "Projects",
                                project.name +
                                    (project.cm_number
                                        ? ` (${project.cm_number})`
                                        : ""),
                                "Add Documents",
                            ]}
                            projectId={projectId}
                        />
                    ) : null
                }
                onOwnerOnlyAction={setOwnerOnlyAction}
                documentRemovalMode={
                    isAnonymousMode ? "detach" : "delete"
                }
            />
        </>
    );
}

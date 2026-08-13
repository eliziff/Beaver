"use client";

import {
    useCallback,
    useEffect,
    useState,
} from "react";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { isAnonymousMode } from "@/app/lib/authMode";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import {
    DocTable,
    type DocTableSelectionActions,
} from "@/app/components/documents/DocTable";
import { DocumentAutomation } from "@/app/components/documents/DocumentAutomation";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { NativeActionSelect } from "@/app/components/ui/native-action-select";
import { projectBreadcrumbLabel } from "./ProjectPageParts";
import { ProjectSectionToolbar, useProjectWorkspace } from "./ProjectWorkspace";
import { useProjectFiles } from "./useProjectFiles";
export function ProjectDocumentsView() {
    const {
        projectId,
        project,
        prefetchProjectSections,
        search,
        setAddDocumentsHeaderAction,
        setOwnerOnlyAction,
    } = useProjectWorkspace();
    const projectLoading = project === undefined;
    const [createFolderAction, setCreateFolderAction] = useState<
        (() => void) | null
    >(null);
    const [selectionActions, setSelectionActions] =
        useState<DocTableSelectionActions | null>(null);
    useEffect(() => {
        if (!projectLoading) prefetchProjectSections();
    }, [projectLoading, prefetchProjectSections]);
    const files = useProjectFiles();
    const { documents, folders, operations } = files;
    const handleCreateFolderActionChange = useCallback(
        (action: (() => void) | null) => {
            setCreateFolderAction(() => action);
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
                folders={folders}
                loading={projectLoading || files.loading}
                search={search}
                operations={operations}
                onAddDocumentsActionChange={setAddDocumentsHeaderAction}
                onCreateFolderActionChange={handleCreateFolderActionChange}
                onSelectionActionsChange={setSelectionActions}
                renderAddDocumentsModal={(open, onClose, onSelect) =>
                    project ? (
                        <AddDocumentsModal
                            open={open}
                            onClose={onClose}
                            onSelect={onSelect}
                            breadcrumb={[
                                "Projects",
                                projectBreadcrumbLabel(project),
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
                hasMoreParents={files.hasMoreParents}
                loadingParents={files.loadingParents}
                onFolderExpanded={files.onFolderExpanded}
                onLoadMore={files.onLoadMore}
            />
        </>
    );
}

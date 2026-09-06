import {
    useCallback,
    useState,
} from "react";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import { DocTable } from "@/app/components/documents/DocTable";
import { DirectoryActions, type DocumentSelectionActions,
    type UploadActions } from "@/app/components/documents/UploadAction";
import { projectBreadcrumbLabel } from "./ProjectPageParts";
import { ProjectSectionTabs, useProjectWorkspace } from "./ProjectWorkspace";
import { useProjectFiles } from "./useProjectFiles";
import { assistantWorkflowLaunch, type WorkflowSelection } from "../workflows/workflowRoutes";
import { type Document, listDirectoryDocuments } from "@/app/lib/api/documents";

export function ProjectDocumentsView() {
    const {
        projectId,
        project,
        search,
        setOwnerOnlyAction,
        createChat,
    } = useProjectWorkspace();
    const projectLoading = project === undefined;
    const [createFolderAction, setCreateFolderAction] = useState<
        (() => void) | null
    >(null);
    const [uploadActions, setUploadActions] = useState<UploadActions | null>(null);
    const [selectionActions, setSelectionActions] =
        useState<DocumentSelectionActions | null>(null);
    const files = useProjectFiles(search);
    const { documents, folders, operations } = files;
    const handleCreateFolderActionChange = useCallback(
        (action: (() => void) | null) => {
            setCreateFolderAction(() => action);
        },
        [],
    );
    const handleUploadActionsChange = useCallback(
        (actions: UploadActions | null) => setUploadActions(actions), [],
    );
    const openAssistantWorkflow = useCallback((selection: WorkflowSelection, documents: Document[]) =>
        void createChat(documents, assistantWorkflowLaunch(selection)), [createChat]);
    const toolbarActions = project !== null
        ? <DirectoryActions actions={uploadActions} busy={projectLoading}
            onCreateFolder={createFolderAction} selection={selectionActions}
            resolveDocuments={() => listDirectoryDocuments(operations.list)}
            onOpenSelectionInChat={(documents) => { void createChat(documents); }}
            onAssistantWorkflowSelect={openAssistantWorkflow} />
        : null;
    return (
        <ProjectSectionTabs actions={toolbarActions}>
            <DocTable
                scopeKey={projectId}
                documents={documents}
                folders={folders}
                loading={projectLoading || files.loading}
                search={search}
                operations={operations}
                onUploadActionsChange={handleUploadActionsChange}
                onCreateFolderActionChange={handleCreateFolderActionChange}
                onSelectionActionsChange={setSelectionActions}
                onAssistantWorkflowSelect={openAssistantWorkflow}
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
                documentRemovalMode="detach"
                hasMoreParents={files.hasMoreParents}
                loadingParents={files.loadingParents}
                onFolderExpanded={files.onFolderExpanded}
                onLoadMore={files.onLoadMore}
            />
        </ProjectSectionTabs>
    );
}

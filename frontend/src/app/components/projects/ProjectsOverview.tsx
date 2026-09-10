import { useNavigationPrefetch } from "@/app/hooks/useNavigationPrefetch";
import { projectsCollection } from "@/app/lib/collectionKeys";
import { useEffect, useState } from "react";
import { useDebounced } from "@/app/hooks/useDebounced";
import { Link, useNavigate } from "react-router-dom";
import { MessageSquarePlus } from "lucide-react";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { listProjects, updateProject, deleteProject, type Project } from "@/app/lib/api/projects";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { useAuth } from "@/app/contexts/AuthContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";

import { NewProjectModal } from "./NewProjectModal";
import { ProjectDetailsModal } from "./ProjectDetailsModal";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { RowActions } from "@/app/components/shared/RowActions";
import { NewPageAction, PageHeader } from "@/app/components/shared/PageHeader";
import {
    TableBody,
    TableEmptyState,
    TableHeaderCell,
    TableLoadMore,
    TableLoadingState,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    TableSelectionHeader,
    useTableSelection,
} from "@/app/components/shared/TablePrimitive";
import { Button } from "@/app/components/ui/button";
import { formatDate } from "@/app/lib/utils";
import { MoreActionsMenu } from "@/app/components/shared/MoreActionsMenu";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
function isProjectOwner(project: Project, currentUserId?: string | null) {
    return project.is_owner ?? project.user_id === currentUserId;
}
function projectSummary(project: Project, currentUserId?: string | null) {
    const owner = isProjectOwner(project, currentUserId)
        ? "Me"
        : project.owner_display_name?.trim() ||
          project.owner_email?.trim() ||
          "Shared";
    return [
        project.cm_number && `CM ${project.cm_number}`,
        project.practice,
        owner,
    ]
        .filter(Boolean)
        .join(" \u00b7 ");
}
type ProjectFilter = "all" | "mine" | "shared-with-me";
const PROJECT_FILTERS: { id: ProjectFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "mine", label: "Mine" },
    { id: "shared-with-me", label: "Shared with me" },
];
export function ProjectsOverview() {
    const [modalOpen, setModalOpen] = useState(false);
    const [detailsProjectId, setDetailsProjectId] = useState<string | null>(
        null,
    );
    const [activeFilter, setActiveFilter] = useState<ProjectFilter>("all");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [search, setSearch] = useState("");
    const [deleteWarning, setDeleteWarning] = useState<string | null>(null);
    const [deleteRequest, setDeleteRequest] = useState<{ ids: string[]; loading: boolean } | null>(null);
    const navigate = useNavigate();
    const prefetch = useNavigationPrefetch();
    const { saveChat } = useChatHistoryContext();
    const { user, isAuthenticated, authLoading } = useAuth();
    const userId = user?.id;
    const deferredSearch = useDebounced(search.trim());
    const page = usePagedQuery(
        (cursor, signal) => listProjects({
            q: deferredSearch,
            scope: activeFilter,
            cursor,
        }, signal),
        [activeFilter, deferredSearch, userId],
        !authLoading && isAuthenticated && !!userId,
        projectsCollection({ q: deferredSearch, scope: activeFilter }),
        { scope: JSON.stringify([userId, activeFilter]), query: deferredSearch },
    );
    const loading = authLoading || page.loading;
    const rows = page.items;
    const initialLoading = loading && rows.length === 0;
    useEffect(() => setSelectedIds([]), [activeFilter, deferredSearch]);
    const loadError = page.error ? "Could not load projects." : null;
    const detailsProject =
        detailsProjectId
            ? rows.find((project) => project.id === detailsProjectId) ?? null
            : null;
    const selection = useTableSelection(rows, selectedIds, setSelectedIds);
    async function handleProjectDetailsSave(values: {
        name: string;
        cmNumber: string;
        practice: string;
    }) {
        if (!detailsProject) return;
        const updated = await updateProject(detailsProject.id, {
            name: values.name,
            cm_number: values.cmNumber,
            practice: values.practice || null,
        });
        page.setItems((previous) =>
            previous.map((project) =>
                project.id === updated.id ? updated : project,
            ),
        );
    }
    async function openProjectChat(projectId: string) {
        const chatId = await saveChat(projectId);
        if (chatId) navigate(`/projects/${projectId}/assistant/chat/${chatId}`);
    }
    async function confirmDelete() {
        if (!deleteRequest) return;
        const ids = deleteRequest.ids;
        const requested = new Set(ids);
        setDeleteRequest({ ids, loading: true });
        const owned = rows
            .filter(
                (project) =>
                    requested.has(project.id) &&
                    isProjectOwner(project, user?.id),
            )
            .map((project) => project.id);
        const blocked = ids.length - owned.length;
        const results = await Promise.allSettled(owned.map((id) => deleteProject(id)));
        const deletedIds = new Set(owned.filter((_, index) => results[index].status === "fulfilled"));
        const failedIds = owned.filter((_, index) => results[index].status === "rejected");
        setSelectedIds(failedIds);
        page.setItems((previous) =>
            previous.filter((project) => !deletedIds.has(project.id)),
        );
        const failed = rows.filter((project) => failedIds.includes(project.id))
            .map((project) => `${project.name} (${project.id})`).join(", ");
        setDeleteWarning([
            blocked > 0 && `${blocked} selected ${blocked === 1 ? "project was" : "projects were"} not owned by you.`,
            failed && `Could not delete ${failed}. Try again.`,
        ].filter(Boolean).join(" ") || null);
        setDeleteRequest(null);
    }
    const deleteSelected = { label: "Delete",
        onSelect: () => setDeleteRequest({ ids: selectedIds, loading: false }) };
    const selectionItems = [
        ...(selectedIds.length === 1 ? [{
            label: "Open in new chat",
            onSelect: () => void openProjectChat(selectedIds[0]),
        }] : []),
        deleteSelected,
    ];
    const selectionMenu = (label: string, items: typeof selectionItems) => <MoreActionsMenu
        label={label} items={items}
        triggerClassName="h-8 w-8 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100" />;
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <PageHeader loading={initialLoading} actions={[
                { type: "search", value: search, onChange: setSearch,
                    placeholder: "Search projects", booleanSearch: true },
            ]}>
                <h1 className="font-serif text-2xl font-medium text-gray-900">Projects</h1>
            </PageHeader>
            <TableToolbar
                items={PROJECT_FILTERS}
                active={activeFilter}
                ariaLabel="Project filters"
                actions={<NewPageAction title="New project" disabled={initialLoading}
                    onClick={() => setModalOpen(true)} />}
                onChange={(nextFilter) => {
                    setActiveFilter(nextFilter);
                    setSelectedIds([]);
                }}
            />
            <TableScrollArea
                className="[&>div]:bg-white"
                header={<TableSelectionHeader
                    label={selectedIds.length ? `${selectedIds.length} selected` : "Name"}
                    loading={selectedIds.length ? undefined : initialLoading}
                    selection={selection} selectionLabel="Select loaded projects"
                    className="w-full min-w-0 bg-white"
                    primaryClassName="min-w-0 flex-1 bg-white"
                    widthClassName="min-w-0 flex-1"
                    leading={selectedIds.length ? undefined : <span aria-hidden="true"
                        className="mr-2 h-5 w-5 shrink-0" />}>
                    {selectedIds.length ? <>
                        <div className="hidden h-8 shrink-0 items-center gap-1.5 sm:flex">
                            {selectedIds.length === 1 && <Button variant="outline"
                                className="h-8 py-0"
                                onClick={() => void openProjectChat(selectedIds[0])}
                            >
                                <MessageSquarePlus className="h-3.5 w-3.5" />
                                Open in new chat
                            </Button>}
                            {selectionMenu("More actions for selected projects", [deleteSelected])}
                        </div>
                        <div className="sm:hidden">
                            {selectionMenu("Actions", selectionItems)}
                        </div>
                    </> : <TableHeaderCell className="w-8" />}
                </TableSelectionHeader>}
            >
                {initialLoading ? (
                    <TableLoadingState />
                ) : loadError || rows.length === 0 ? (
                    <TableEmptyState>
                        <FolderSvgIcon
                            className="mb-3 h-8 w-8 text-gray-700"
                        />
                        <p
                            className={`text-sm font-medium ${
                                loadError ? "text-red-700" : "text-gray-700"
                            }`}
                        >
                            {loadError ??
                                (deferredSearch
                                    ? "No projects match your search."
                                    : activeFilter === "shared-with-me"
                                      ? "No shared projects"
                                      : "No projects")}
                        </p>
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {rows.map((project) => (
                            <TableRow
                                key={project.id}
                                selected={selection.selected.has(project.id)}
                                className="h-14 w-full min-w-0 bg-white"
                                onClick={() =>
                                    navigate(`/projects/${project.id}`)
                                }
                            >
                                <TablePrimaryCell
                                    selected={selection.selected.has(project.id)}
                                    className="min-w-0 flex-1 [&>div]:flex-1"
                                    widthClassName="min-w-0 flex-1"
                                    onSelectionChange={() => selection.toggle(project.id)}
                                    checkboxTitle={`Select ${project.name}`}
                                >
                                    <FolderSvgIcon
                                        className="mr-2 h-5 w-5 shrink-0 text-gray-700"
                                    />
                                    <div className="min-w-0 flex-1">
                                        <Link to={`/projects/${project.id}`}
                                            onPointerEnter={event => { if (event.pointerType !== "touch") prefetch(`/projects/${project.id}`); }}
                                            onFocus={() => prefetch(`/projects/${project.id}`)}
                                            onClick={(event) => event.stopPropagation()}
                                            className="block truncate rounded-sm text-base font-medium text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900">
                                            {project.name}
                                        </Link>
                                        <div className="truncate text-xs text-gray-600">
                                            {projectSummary(project, user?.id)}
                                            {" \u00b7 "}
                                            <time>
                                                {formatDate(project.created_at)}
                                            </time>
                                        </div>
                                    </div>
                                </TablePrimaryCell>
                                <div
                                    className="flex w-8 shrink-0 justify-end"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {isProjectOwner(project, user?.id) && (
                                        <RowActions
                                            onEditDetails={() =>
                                                setDetailsProjectId(project.id)
                                            }
                                            onDelete={() => setDeleteRequest({ ids: [project.id], loading: false })}
                                        />
                                    )}
                                </div>
                            </TableRow>
                        ))}
                    </TableBody>
                )}
            </TableScrollArea>
            <TableLoadMore show={page.hasMore && !loading && !loadError} onClick={() => void page.loadMore()} />
            <NewProjectModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onCreated={(p) => {
                    page.setItems((previous) => [p, ...previous]);
                    navigate(`/projects/${p.id}`);
                }}
            />
            <ProjectDetailsModal
                open={!!detailsProject}
                project={detailsProject}
                canEdit={
                    !!detailsProject && isProjectOwner(detailsProject, user?.id)
                }
                onClose={() => setDetailsProjectId(null)}
                onSave={handleProjectDetailsSave}
            />
            <WarningPopup
                open={!!deleteWarning}
                title="Some projects were not deleted"
                message={deleteWarning}
                onClose={() => setDeleteWarning(null)}
            />
            <ConfirmPopup open={!!deleteRequest}
                title={`Delete ${deleteRequest?.ids.length === 1 ? "project" : `${deleteRequest?.ids.length} projects`}?`}
                message="This permanently deletes the selected project data."
                confirmLabel="Delete" confirmStatus={deleteRequest?.loading ? "loading" : "idle"}
                onConfirm={() => void confirmDelete()}
                onCancel={() => { if (!deleteRequest?.loading) setDeleteRequest(null); }} />
        </div>
    );
}

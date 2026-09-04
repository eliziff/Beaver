"use client";
import { useDeferredValue, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MessageSquarePlus } from "lucide-react";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import {
    listProjects,
    updateProject,
    deleteProject,
} from "@/app/lib/beaverApi";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { useAuth } from "@/app/contexts/AuthContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import type { Project } from "@/app/components/shared/types";
import { NewProjectModal } from "./NewProjectModal";
import { ProjectDetailsModal } from "./ProjectDetailsModal";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { RowActions } from "@/app/components/shared/RowActions";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    SkeletonLine,
    TableBody,
    TableEmptyState,
    TableHeaderCell,
    TableLoadMore,
    TableLoadingRows,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    TableSelectionHeader,
    useTableSelection,
} from "@/app/components/shared/TablePrimitive";
import { Button } from "@/app/components/ui/button";
import { SearchBar } from "@/app/components/ui/search-bar";
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
const SKELETON_ROWS = 3;
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
    const { saveChat } = useChatHistoryContext();
    const { user, isAuthenticated, authLoading } = useAuth();
    const userId = user?.id;
    const deferredSearch = useDeferredValue(search.trim());
    const page = usePagedQuery(
        (cursor, signal) => listProjects({
            q: deferredSearch,
            scope: activeFilter,
            cursor,
        }, signal),
        [activeFilter, deferredSearch, userId],
        !authLoading && isAuthenticated && !!userId,
    );
    const loading = authLoading || page.loading;
    const rows = page.items;
    useEffect(() => setSelectedIds([]), [activeFilter, deferredSearch]);
    const loadError = page.error ? "Could not load projects." : null;
    function updateProjects(update: (rows: Project[]) => Project[]) {
        page.setItems(update);
    }
    const q = deferredSearch.toLowerCase();
    const filtered = rows;
    const detailsProject =
        detailsProjectId
            ? rows.find((project) => project.id === detailsProjectId) ?? null
            : null;
    const selection = useTableSelection(filtered, selectedIds, setSelectedIds);
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
        updateProjects((previous) =>
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
        updateProjects((previous) =>
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
    const selectionItems = [
        ...(selectedIds.length === 1 ? [{
            label: "Open in new chat",
            onSelect: () => void openProjectChat(selectedIds[0]),
        }] : []),
        { label: "Delete", onSelect: () => setDeleteRequest({ ids: selectedIds, loading: false }) },
    ];
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <PageHeader loading={loading}>
                <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <h1 className="text-2xl font-medium font-serif text-gray-900">
                        Projects
                    </h1>
                    <div className="flex min-w-0 items-center gap-2 sm:w-auto">
                        <SearchBar
                            data-page-search
                            aria-keyshortcuts="/"
                            value={search}
                            onValueChange={setSearch}
                            placeholder="Search projects"
                            aria-label="Search projects"
                            disabled={loading}
                            booleanSearch
                            wrapperClassName="min-w-0 flex-1 border-gray-300 bg-white shadow-none sm:w-72"
                        />
                        <Button
                            data-page-new
                            aria-keyshortcuts="Alt+N"
                            aria-label="New project"
                            onClick={() => setModalOpen(true)}
                            disabled={loading}
                            className="h-9 shrink-0 shadow-none"
                        >
                            <FolderSvgIcon className="h-4 w-4" />
                            <span className="hidden sm:inline">New project</span>
                        </Button>
                    </div>
                </div>
            </PageHeader>
            <TableToolbar
                items={PROJECT_FILTERS}
                active={activeFilter}
                ariaLabel="Project filters"
                onChange={(nextFilter) => {
                    setActiveFilter(nextFilter);
                    setSelectedIds([]);
                }}
            />
            <TableScrollArea
                className="[&>div]:bg-white"
                header={<TableSelectionHeader
                    label={selectedIds.length ? `${selectedIds.length} selected` : "Name"}
                    loading={selectedIds.length ? undefined : loading}
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
                            <MoreActionsMenu
                                label="More actions for selected projects"
                                items={[{ label: "Delete", onSelect: () => setDeleteRequest({ ids: selectedIds, loading: false }) }]}
                                triggerClassName="h-8 w-8 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100"
                            />
                        </div>
                        <div className="sm:hidden">
                            <MoreActionsMenu
                                label="Actions"
                                items={selectionItems}
                                triggerClassName="h-8 w-8 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100"
                            />
                        </div>
                    </> : <TableHeaderCell className="w-8" />}
                </TableSelectionHeader>}
            >
                {loading ? (
                    <TableLoadingRows count={SKELETON_ROWS}
                        rowClassName="h-14 w-full min-w-0 bg-white"
                        primaryClassName="min-w-0 flex-1"
                        primaryWidthClassName="min-w-0 flex-1"
                        columns={[{ className: "w-8" }]}
                        renderPrimary={() => <>
                            <div className="mr-2 h-5 w-5 shrink-0 rounded bg-gray-100" />
                            <div className="min-w-0 flex-1 space-y-1.5">
                                <SkeletonLine className="h-3.5 w-48" />
                                <SkeletonLine className="h-2.5 w-72 max-w-full" />
                            </div>
                        </>} />
                ) : loadError || filtered.length === 0 ? (
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
                                (q
                                    ? "No projects match your search."
                                    : activeFilter === "shared-with-me"
                                      ? "No shared projects"
                                      : "No projects")}
                        </p>
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {filtered.map((project) => (
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
                    updateProjects((previous) => [p, ...previous]);
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

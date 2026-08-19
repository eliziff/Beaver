"use client";
import { useDeferredValue, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MessageSquarePlus } from "lucide-react";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import {
    listProjects,
    updateProject,
    deleteProject,
} from "@/app/lib/beaverApi";
import { OwnerOnlyPopup } from "@/app/components/popups/OwnerOnlyPopup";
import { useAuth } from "@/app/contexts/AuthContext";
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
import { PillButton } from "@/app/components/ui/pill-button";
import { SearchBar } from "@/app/components/ui/search-bar";
import { formatDate } from "@/app/lib/utils";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
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
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const navigate = useNavigate();
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
    async function handleDeleteSelected() {
        const ids = selectedIds;
        const owned = rows
            .filter(
                (project) =>
                    selection.selected.has(project.id) &&
                    isProjectOwner(project, user?.id),
            )
            .map((project) => project.id);
        const ownedIds = new Set(owned);
        const blocked = ids.length - owned.length;
        setSelectedIds([]);
        await Promise.all(owned.map((id) => deleteProject(id).catch(() => {})));
        updateProjects((previous) =>
            previous.filter((project) => !ownedIds.has(project.id)),
        );
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected projects — only the project owner can delete a project`,
            );
        }
    }
    async function handleDeleteOne(id: string) {
        await deleteProject(id);
        updateProjects((previous) =>
            previous.filter((project) => project.id !== id),
        );
    }
    const toolbarActions = (
        <span
            aria-label="Selected project actions"
            className="inline-flex h-8 w-[17rem] items-center justify-end gap-1.5"
        >
            <TabPillButton
                disabled={selectedIds.length !== 1}
                onClick={() =>
                    navigate(`/projects/${selectedIds[0]}/assistant`)
                }
            >
                <MessageSquarePlus className="h-3.5 w-3.5" />
                Open in new chat
            </TabPillButton>
            <PillButton
                tone="danger"
                className={`h-8 ${selectedIds.length ? "" : "invisible pointer-events-none"}`}
                onClick={() => void handleDeleteSelected()}
                aria-hidden={!selectedIds.length}
                tabIndex={selectedIds.length ? undefined : -1}
            >
                Delete selected
            </PillButton>
        </span>
    );
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
                            placeholder="Search projects..."
                            aria-label="Search projects"
                            disabled={loading}
                            wrapperClassName="min-w-0 flex-1 border-gray-300 bg-white shadow-none sm:w-72"
                        />
                        <PillButton
                            data-page-new
                            aria-keyshortcuts="Alt+N"
                            tone="black"
                            size="normal"
                            onClick={() => setModalOpen(true)}
                            disabled={loading}
                            className="h-9 shrink-0 shadow-none"
                        >
                            <FolderSvgIcon className="h-4 w-4" />
                            Create project +
                        </PillButton>
                    </div>
                </div>
            </PageHeader>
            <TableToolbar
                items={PROJECT_FILTERS}
                active={activeFilter}
                onChange={(nextFilter) => {
                    setActiveFilter(nextFilter);
                    setSelectedIds([]);
                }}
                actions={toolbarActions}
            />
            <TableScrollArea
                className="[&>div]:bg-white"
                header={
                    <TableSelectionHeader label="Name" loading={loading}
                        selection={selection} selectionLabel="Select loaded projects"
                        className="w-full min-w-0 bg-white"
                        primaryClassName="min-w-0 flex-1 bg-white"
                        widthClassName="min-w-0 flex-1"
                        leading={<span aria-hidden="true"
                            className="mr-2 h-5 w-5 shrink-0" />}>
                        <TableHeaderCell className="w-8" />
                    </TableSelectionHeader>
                }
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
                    <TableEmptyState className="items-center text-center">
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
                                        <div className="truncate text-base font-medium text-gray-900">
                                            {project.name}
                                        </div>
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
                                            onDelete={() =>
                                                void handleDeleteOne(project.id)
                                            }
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
            <OwnerOnlyPopup
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>
    );
}

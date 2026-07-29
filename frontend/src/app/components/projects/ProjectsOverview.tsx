"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableHeaderRow,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    TableSelectionPlaceholder,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { CheckboxControl } from "@/app/components/ui/checkbox";
import { PillButton } from "@/app/components/ui/pill-button";
import { SearchBar } from "@/app/components/ui/search-bar";
import { formatDate } from "@/app/lib/utils";
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
        `${project.document_count ?? 0} files`,
        `${project.chat_count ?? 0} chats`,
        `${project.review_count ?? 0} reviews`,
    ]
        .filter(Boolean)
        .join(" \u00b7 ");
}
type ProjectFilter = "all" | "mine" | "shared-with-me";
type ProjectListState = { userId: string; rows: Project[]; error: string | null };
const PROJECT_FILTERS: { id: ProjectFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "mine", label: "Mine" },
    { id: "shared-with-me", label: "Shared with me" },
];
const EMPTY_PROJECTS: Project[] = [];
const SKELETON_ROWS = [0, 1, 2];
export function ProjectsOverview() {
    const [projectList, setProjectList] = useState<ProjectListState | null>(
        null,
    );
    const [modalOpen, setModalOpen] = useState(false);
    const [detailsProjectId, setDetailsProjectId] = useState<string | null>(
        null,
    );
    const [activeFilter, setActiveFilter] = useState<ProjectFilter>("all");
    const [selectedIds, setSelectedIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [search, setSearch] = useState("");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const router = useRouter();
    const { user, isAuthenticated, authLoading } = useAuth();
    const userId = user?.id;
    useEffect(() => {
        if (authLoading || !isAuthenticated || !userId) return;
        let active = true;
        void listProjects()
            .then((loaded) => {
                if (active)
                    setProjectList({ userId, rows: loaded, error: null });
            })
            .catch((error) => {
                console.error("[projects] failed to load projects", error);
                if (active)
                    setProjectList({
                        userId, rows: [], error: "Could not load projects.",
                    });
            });
        return () => {
            active = false;
        };
    }, [authLoading, isAuthenticated, userId]);
    const currentList =
        projectList?.userId === userId ? projectList : null;
    const loading = authLoading || (isAuthenticated && !currentList);
    const rows = currentList?.rows ?? EMPTY_PROJECTS;
    const loadError = currentList?.error ?? null;
    function updateProjects(update: (rows: Project[]) => Project[]) {
        setProjectList((current) => {
            if (!current || current.userId !== userId) return current;
            return { ...current, rows: update(current.rows) };
        });
    }
    const q = search.trim().toLowerCase();
    const filtered = useMemo(
        () =>
            rows.filter((project) => {
                const owned = isProjectOwner(project, user?.id);
                return (
                    (activeFilter === "all" ||
                        (activeFilter === "mine" && owned) ||
                        (activeFilter === "shared-with-me" && !owned)) &&
                    (!q ||
                        project.name.toLowerCase().includes(q) ||
                        (project.cm_number ?? "").toLowerCase().includes(q) ||
                        (project.practice ?? "").toLowerCase().includes(q))
                );
            }),
        [activeFilter, q, rows, user?.id],
    );
    const detailsProject =
        detailsProjectId
            ? rows.find((project) => project.id === detailsProjectId) ?? null
            : null;
    const allSelected =
        filtered.length > 0 &&
        filtered.every((project) => selectedIds.has(project.id));
    const someSelected =
        !allSelected && filtered.some((project) => selectedIds.has(project.id));
    function toggleAll() {
        setSelectedIds(
            allSelected
                ? new Set()
                : new Set(filtered.map((project) => project.id)),
        );
    }
    function toggleOne(id: string) {
        setSelectedIds((previous) => {
            const next = new Set(previous);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    }
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
        const ids = [...selectedIds];
        const owned = rows
            .filter(
                (project) =>
                    selectedIds.has(project.id) &&
                    isProjectOwner(project, user?.id),
            )
            .map((project) => project.id);
        const ownedIds = new Set(owned);
        const blocked = ids.length - owned.length;
        setSelectedIds(new Set());
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
        <span className="inline-flex h-8 w-28">
            {selectedIds.size > 0 && (
                <PillButton
                    tone="danger"
                    className="h-8 w-full"
                    onClick={() => void handleDeleteSelected()}
                >
                    Delete selected
                </PillButton>
            )}
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
                    setSelectedIds(new Set());
                }}
                actions={toolbarActions}
            />
            <TableScrollArea
                className="[&>div]:bg-white"
                header={
                    <TableHeaderRow className="w-full min-w-0 bg-white">
                        <TableStickyCell
                            header
                            className="min-w-0 flex-1 bg-white"
                            widthClassName="min-w-0 flex-1"
                        >
                            {loading ? (
                                <span className="-ml-2 mr-1 h-9 w-9 shrink-0" />
                            ) : (
                                <CheckboxControl
                                    checked={allSelected}
                                    ref={(el) => {
                                        if (el) el.indeterminate = someSelected;
                                    }}
                                    onChange={toggleAll}
                                    className="-ml-2 mr-1"
                                />
                            )}
                            <span
                                aria-hidden="true"
                                className="mr-2 h-5 w-5 shrink-0"
                            />
                            <span className="mr-1">Name</span>
                        </TableStickyCell>
                        <TableHeaderCell className="w-8" />
                    </TableHeaderRow>
                }
            >
                {loading ? (
                    <TableBody>
                        {SKELETON_ROWS.map((i) => (
                            <TableRow
                                key={i}
                                interactive={false}
                                className="h-14 w-full min-w-0 bg-white"
                            >
                                <TableStickyCell
                                    className="min-w-0 flex-1"
                                    widthClassName="min-w-0 flex-1"
                                >
                                    <TableSelectionPlaceholder />
                                    <div className="mr-2 h-5 w-5 shrink-0 rounded bg-gray-100" />
                                    <div className="min-w-0 flex-1 space-y-1.5">
                                        <SkeletonLine className="h-3.5 w-48" />
                                        <SkeletonLine className="h-2.5 w-72 max-w-full" />
                                    </div>
                                </TableStickyCell>
                                <TableCell className="w-8" />
                            </TableRow>
                        ))}
                    </TableBody>
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
                                selected={selectedIds.has(project.id)}
                                className="h-14 w-full min-w-0 bg-white"
                                onClick={() =>
                                    router.push(`/projects/${project.id}`)
                                }
                            >
                                <TablePrimaryCell
                                    selected={selectedIds.has(project.id)}
                                    className="min-w-0 flex-1 [&>div]:flex-1"
                                    widthClassName="min-w-0 flex-1"
                                    onSelectionChange={() =>
                                        toggleOne(project.id)
                                    }
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
            <NewProjectModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onCreated={(p) => {
                    updateProjects((previous) => [p, ...previous]);
                    router.push(`/projects/${p.id}`);
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

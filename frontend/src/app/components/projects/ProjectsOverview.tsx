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
    TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { CheckboxControl } from "@/app/components/ui/checkbox";
import { PillButton } from "@/app/components/ui/pill-button";
import { SearchBar } from "@/app/components/ui/search-bar";
import { NativeActionSelect } from "@/app/components/ui/native-action-select";import { formatDate } from "@/app/lib/utils";function getProjectOwnerLabel(project: Project, currentUserId?: string | null) {
    if (project.is_owner ?? project.user_id === currentUserId) return "Me";
    return (
        project.owner_display_name?.trim() ||
        project.owner_email?.trim() ||
        "Shared"
    );
}
type ProjectFilter = "all" | "mine" | "shared-with-me";
const PROJECT_COLUMN = {
    cm: "hidden w-24 sm:flex",
    practice: "hidden w-32 xl:flex",
    owner: "hidden w-28 2xl:flex",
    files: "hidden w-20 lg:flex",
    chats: "hidden w-20 lg:flex",
    reviews: "hidden w-28 xl:flex",
    created: "hidden w-28 2xl:flex",
    actions: "w-8",
} as const;
export function ProjectsOverview() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [detailsProject, setDetailsProject] = useState<Project | null>(null);
    const [activeFilter, setActiveFilter] = useState<ProjectFilter>("all");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [search, setSearch] = useState("");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const router = useRouter();
    const { user, isAuthenticated, authLoading } = useAuth();
    useEffect(() => {
        let cancelled = false;
        async function loadProjects() {
            await Promise.resolve();
            if (cancelled) return;
            if (authLoading) {
                setLoading(true);
                return;
            }
            if (!isAuthenticated) {
                setProjects([]);
                setLoadError(null);
                setLoading(false);
                return;
            }
            setLoading(true);
            setLoadError(null);
            try {
                const loaded = await listProjects();
                if (!cancelled) setProjects(loaded);
            } catch (err) {
                console.error("[projects] failed to load projects", err);
                if (!cancelled) {
                    setProjects([]);
                    setLoadError("Could not load projects.");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        void loadProjects();
        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, user?.id]);
    const q = search.toLowerCase();
    const filtered = useMemo(() => {
        const rows = (
            activeFilter === "all"
                ? projects
                : activeFilter === "mine"
                  ? projects.filter(
                        (p) => p.is_owner ?? p.user_id === user?.id,
                    )
                  : projects.filter(
                        (p) => !(p.is_owner ?? p.user_id === user?.id),
                    )
        )
            .filter(
                (p) =>
                    !q ||
                    p.name.toLowerCase().includes(q) ||
                    (p.cm_number ?? "").toLowerCase().includes(q) ||
                    (p.practice ?? "").toLowerCase().includes(q),
            )
        return rows;
    }, [
        activeFilter,
        q,
        user?.id,
        projects,
    ]);
    const allSelected =
        filtered.length > 0 &&
        filtered.every((p) => selectedIds.includes(p.id));
    const someSelected =
        !allSelected && filtered.some((p) => selectedIds.includes(p.id));
    function toggleAll() {
        if (allSelected) {
            setSelectedIds([]);
        } else {
            setSelectedIds(filtered.map((p) => p.id));
        }
    }
    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }
    function clearSelection() {
        setSelectedIds([]);
    }
    const filters: { id: ProjectFilter; label: string }[] = [
        { id: "all", label: "All" },
        { id: "mine", label: "Mine" },
        { id: "shared-with-me", label: "Shared with me" },
    ];
    async function handleProjectDetailsSave(values: {
        name: string;
        cmNumber: string;
        practice: string;
    }) {
        if (!detailsProject) return;
        if (
            detailsProject.is_owner === false ||
            (user?.id && detailsProject.user_id !== user.id)
        ) {
            setOwnerOnlyAction("edit project details");
            return;
        }
        const name = values.name.trim();
        const cmNumber = values.cmNumber.trim();
        const practice = values.practice.trim();
        if (!name) return;
        const updated = await updateProject(detailsProject.id, {
            name,
            cm_number: cmNumber,
            practice: practice || null,
        });
        setProjects((prev) =>
            prev.map((project) =>
                project.id === updated.id ? { ...project, ...updated } : project,
            ),
        );
        setDetailsProject((current) =>
            current?.id === updated.id ? { ...current, ...updated } : current,
        );
    }
    async function handleDeleteSelected() {
        const ids = [...selectedIds];
        const owned = ids.filter((id) => {
            const p = projects.find((pp) => pp.id === id);
            return !p || (p.is_owner ?? p.user_id === user?.id);
        });
        const blocked = ids.length - owned.length;
        setSelectedIds([]);
        await Promise.all(owned.map((id) => deleteProject(id).catch(() => {})));
        setProjects((prev) => prev.filter((p) => !owned.includes(p.id)));
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected projects — only the project owner can delete a project`,
            );
        }
    }
    const toolbarActions = (
        <span className="inline-flex h-8 w-28">
            {selectedIds.length > 0 && (
                <NativeActionSelect
                    label="Actions"
                    items={[
                        {
                            label: "Delete",
                            onSelect: () => void handleDeleteSelected(),
                        },
                    ]}
                    className="w-full"
                    triggerClassName="h-8 w-full items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 hover:bg-gray-100 hover:text-gray-950"
                >
                    Actions
                    <span aria-hidden="true">&#9662;</span>
                </NativeActionSelect>
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
                items={filters}
                active={activeFilter}
                onChange={(nextFilter) => {
                    setActiveFilter(nextFilter);
                    clearSelection();
                }}
                actions={toolbarActions}
            />
            <TableScrollArea
                className="[&>div]:bg-white"
                header={
                    <TableHeaderRow className="bg-white">
                        <TableStickyCell
                            header
                            className="bg-white"
                            widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
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
                        <TableHeaderCell className={`ml-auto ${PROJECT_COLUMN.cm}`}>
                            <div className="flex items-center gap-1">
                                <span>CM</span>
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className={PROJECT_COLUMN.practice}>
                            <div className="flex items-center gap-1">
                                <span>Practice</span>
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className={PROJECT_COLUMN.owner}>
                            <div className="flex items-center gap-1">
                                <span>Owner</span>
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className={PROJECT_COLUMN.files}>
                            <div className="flex items-center gap-1">
                                <span>Files</span>
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className={PROJECT_COLUMN.chats}>
                            <div className="flex items-center gap-1">
                                <span>Chats</span>
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className={PROJECT_COLUMN.reviews}>
                            <div className="flex items-center gap-1">
                                <span>Reviews</span>
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className={PROJECT_COLUMN.created}>
                            <div className="flex items-center gap-1">
                                <span>Created</span>
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className={PROJECT_COLUMN.actions} />
                    </TableHeaderRow>
                }
            >
                {loading ? (
                    <TableBody>
                        {[1, 2, 3].map((i) => (
                            <TableRow
                                key={i}
                                interactive={false}
                                className="bg-white"
                            >
                                <TableStickyCell
                                    hover={false}
                                    bgClassName="bg-transparent"
                                    widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                                >
                                    <TableSelectionPlaceholder />
                                    <div className="mr-2 h-5 w-5 shrink-0 rounded bg-gray-100" />
                                    <SkeletonLine className="h-3.5 w-48" />
                                </TableStickyCell>
                                <TableCell className={`ml-auto ${PROJECT_COLUMN.cm}`}>
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className={PROJECT_COLUMN.practice}>
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className={PROJECT_COLUMN.owner}>
                                    <SkeletonLine className="w-16" />
                                </TableCell>
                                <TableCell className={PROJECT_COLUMN.files}>
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className={PROJECT_COLUMN.chats}>
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className={PROJECT_COLUMN.reviews}>
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className={PROJECT_COLUMN.created}>
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className={PROJECT_COLUMN.actions} />
                            </TableRow>
                        ))}
                    </TableBody>
                ) : loadError ? (
                    <TableEmptyState className="items-center text-center">
                        <FolderSvgIcon
                            className="mb-3 h-8 w-8 text-gray-700"
                        />
                        <p className="text-sm font-medium text-red-700">
                            {loadError}
                        </p>
                    </TableEmptyState>
                ) : filtered.length === 0 ? (
                    <TableEmptyState className="items-center text-center">
                        <FolderSvgIcon
                            className="mb-3 h-8 w-8 text-gray-700"
                        />
                        <p className="text-sm font-medium text-gray-700">
                            {search.trim()
                                ? "No projects match your search."
                                : activeFilter === "shared-with-me"
                                  ? "No shared projects"
                                  : "No projects"}
                        </p>
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {filtered.map((project) => {
                            return (
                            <TableRow
                                key={project.id}
                                selected={selectedIds.includes(project.id)}
                                className="bg-white"
                                onClick={() => {
                                    router.push(`/projects/${project.id}`);
                                }}
                            >
                                <TablePrimaryCell
                                    selected={selectedIds.includes(project.id)}
                                    widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                                    onSelectionChange={() =>
                                        toggleOne(project.id)
                                    }
                                    bgClassName="bg-white"
                                >
                                    <FolderSvgIcon
                                        className="mr-2 h-5 w-5 shrink-0 text-gray-700"
                                    />
                                    <span className="min-w-0 flex-1 truncate text-base font-medium text-gray-900">
                                        {project.name}
                                    </span>
                                </TablePrimaryCell>
                                <TableCell className={`ml-auto text-gray-700 ${PROJECT_COLUMN.cm}`}>
                                    {project.cm_number ?? (
                                        <span className="text-gray-500">
                                            —
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className={`text-gray-700 ${PROJECT_COLUMN.practice}`}>
                                    {project.practice ?? (
                                        <span className="text-gray-500">
                                            —
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className={`text-gray-700 ${PROJECT_COLUMN.owner}`}>
                                    {getProjectOwnerLabel(project, user?.id)}
                                </TableCell>
                                <TableCell className={`text-gray-700 ${PROJECT_COLUMN.files}`}>
                                    {project.document_count ?? 0}
                                </TableCell>
                                <TableCell className={`text-gray-700 ${PROJECT_COLUMN.chats}`}>
                                    {project.chat_count ?? 0}
                                </TableCell>
                                <TableCell className={`text-gray-700 ${PROJECT_COLUMN.reviews}`}>
                                    {project.review_count ?? 0}
                                </TableCell>
                                <TableCell className={`text-gray-700 ${PROJECT_COLUMN.created}`}>
                                    {formatDate(project.created_at)}
                                </TableCell>
                                <div
                                    className={`${PROJECT_COLUMN.actions} shrink-0 justify-end`}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {(project.is_owner ??
                                        project.user_id === user?.id) && (
                                        <RowActions
                                            onEditDetails={() => {
                                                setDetailsProject(project);
                                            }}
                                            onDelete={async () => {
                                                await deleteProject(project.id);
                                                setProjects((prev) =>
                                                    prev.filter(
                                                        (p) =>
                                                            p.id !== project.id,
                                                    ),
                                                );
                                            }}
                                        />
                                    )}
                                </div>
                            </TableRow>
                            );
                        })}
                    </TableBody>
                )}
            </TableScrollArea>
            <NewProjectModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onCreated={(p) => {
                    setProjects((prev) => [p, ...prev]);
                    router.push(`/projects/${p.id}`);
                }}
            />
            <ProjectDetailsModal
                open={!!detailsProject}
                project={detailsProject}
                canEdit={
                    !!detailsProject &&
                    detailsProject.is_owner !== false &&
                    (!user?.id || detailsProject.user_id === user.id)
                }
                onClose={() => setDetailsProject(null)}
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

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Plus } from "lucide-react";
import { RowActions } from "@/app/components/shared/RowActions";
import {
    deleteTabularReview,
    listTabularReviews,
    createTabularReview,
    listProjects,
    updateTabularReview,
} from "@/app/lib/beaverApi";
import type { TabularReview, Project } from "@/app/components/shared/types";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { NewTRModal } from "@/app/components/tabular/NewTRModal";
import { TabularReviewDetailsModal } from "@/app/components/tabular/TabularReviewDetailsModal";
import { OwnerOnlyPopup } from "@/app/components/popups/OwnerOnlyPopup";
import { useAuth } from "@/app/contexts/AuthContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    TABLE_CHECKBOX_CLASS,
    SkeletonDot,
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableFilters,
    type TableFilterOption,
    TableHeaderCell,
    TableHeaderRow,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    type TableSortDirection,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { PillButton } from "@/app/components/ui/pill-button";
import { TabularReviewSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { NativeActionSelect } from "@/app/components/ui/native-action-select";

type ReviewScope = "all" | "in-project" | "standalone";
type ReviewSortKey = "name" | "columns" | "documents" | "created";

const REVIEW_SCOPES: { id: ReviewScope; label: string }[] = [
    { id: "all", label: "All" },
    { id: "in-project", label: "In Project" },
    { id: "standalone", label: "Standalone" },
];
const SORT_OPTIONS: TableFilterOption<TableSortDirection>[] = [
    { value: "asc", label: "Ascending" },
    { value: "desc", label: "Descending" },
];

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

export default function TabularReviewsPage() {
    const [reviews, setReviews] = useState<TabularReview[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [newTROpen, setNewTROpen] = useState(false);
    const [detailsReview, setDetailsReview] = useState<TabularReview | null>(
        null,
    );
    const [activeScope, setActiveScope] = useState<ReviewScope>("all");
    const [projectFilter, setProjectFilter] = useState<string | null>(null);
    const [sort, setSort] = useState<{
        key: ReviewSortKey;
        direction: TableSortDirection;
    } | null>(null);
    const [search, setSearch] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const previewEmptyStates = searchParams.get("emptyStates") === "1";
    const effectiveLoading = loading && !previewEmptyStates;
    const visibleReviews = useMemo(
        () => (previewEmptyStates ? [] : reviews),
        [previewEmptyStates, reviews],
    );

    useEffect(() => {
        Promise.all([
            listTabularReviews().catch(() => []),
            listProjects().catch(() => []),
        ])
            .then(([r, p]) => {
                setReviews(r);
                setProjects(p);
            })
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        setSelectedIds([]);
    }, [activeScope, projectFilter]);

    const projectNameById = useMemo(
        () => new Map(projects.map((project) => [project.id, project.name])),
        [projects],
    );
    const q = search.toLowerCase();
    const filtered = useMemo(() => {
        const rows = visibleReviews
            .filter((r) => {
                if (activeScope === "in-project") return !!r.project_id;
                if (activeScope === "standalone") return !r.project_id;
                return true;
            })
            .filter((r) => !projectFilter || r.project_id === projectFilter)
            .filter((r) => !q || (r.title ?? "").toLowerCase().includes(q));

        if (!sort) return rows;

        return [...rows].sort((a, b) => {
            const multiplier = sort.direction === "asc" ? 1 : -1;

            if (sort.key === "columns") {
                return (
                    ((a.columns_config?.length ?? 0) -
                        (b.columns_config?.length ?? 0)) *
                    multiplier
                );
            }

            if (sort.key === "documents") {
                return (
                    ((a.document_count ?? 0) - (b.document_count ?? 0)) *
                    multiplier
                );
            }

            if (sort.key === "created") {
                return (
                    (new Date(a.created_at).getTime() -
                        new Date(b.created_at).getTime()) *
                    multiplier
                );
            }

            return (
                (a.title ?? "Untitled Review").localeCompare(
                    b.title ?? "Untitled Review",
                ) * multiplier
            );
        });
    }, [activeScope, projectFilter, q, sort, visibleReviews]);

    const allSelected =
        filtered.length > 0 &&
        filtered.every((r) => selectedIds.includes(r.id));
    const someSelected =
        !allSelected && filtered.some((r) => selectedIds.includes(r.id));

    function toggleAll() {
        if (allSelected) setSelectedIds([]);
        else setSelectedIds(filtered.map((r) => r.id));
    }

    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }

    function clearSelection() {
        setSelectedIds([]);
    }

    function handleProjectFilterChange(value: string | null) {
        setProjectFilter(value);
        clearSelection();
    }

    function handleSortChange(
        key: ReviewSortKey,
        direction: TableSortDirection | null,
    ) {
        setSort(direction ? { key, direction } : null);
        clearSelection();
    }

    const handleNewReview = async (
        title: string,
        projectId?: string,
        documentIds?: string[],
        columnsConfig?:
            | import("@/app/components/shared/types").ColumnConfig[]
            | null,
    ) => {
        setCreating(true);
        try {
            const review = await createTabularReview({
                title,
                document_ids: documentIds ?? [],
                columns_config: columnsConfig ?? [],
                ...(projectId && { project_id: projectId }),
            });
            router.push(
                projectId
                    ? `/projects/${projectId}/tabular-reviews/${review.id}`
                    : `/tabular-reviews/${review.id}`,
            );
        } finally {
            setCreating(false);
        }
    };

    function requestReviewDetails(review: TabularReview) {
        if (user?.id && review.user_id !== user.id) {
            setOwnerOnlyAction("edit tabular review details");
            return;
        }
        setDetailsReview(review);
    }

    async function handleDetailsSave(values: {
        title: string;
        projectId?: string | null;
    }) {
        if (!detailsReview) return;
        if (user?.id && detailsReview.user_id !== user.id) {
            setOwnerOnlyAction("edit tabular review details");
            return;
        }
        const updated = await updateTabularReview(detailsReview.id, {
            title: values.title,
            project_id: values.projectId ?? null,
        });
        setReviews((prev) =>
            prev.map((review) =>
                review.id === updated.id ? { ...review, ...updated } : review,
            ),
        );
        setDetailsReview((current) =>
            current?.id === updated.id ? { ...current, ...updated } : current,
        );
    }

    async function handleDeleteSelected() {
        const ids = [...selectedIds];
        const owned = ids.filter((id) => {
            const r = reviews.find((rr) => rr.id === id);
            return !r || !user?.id || r.user_id === user.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedIds([]);
        await Promise.all(
            owned.map((id) => deleteTabularReview(id).catch(() => {})),
        );
        setReviews((prev) => prev.filter((r) => !owned.includes(r.id)));
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected reviews — only the review creator can delete a review`,
            );
        }
    }

    const projectFilterButton = (
        <TableFilters
            label="Filter by project"
            value={projectFilter}
            allLabel="All Projects"
            options={projects.map((project) => ({
                value: project.id,
                label: project.name,
            }))}
            onChange={handleProjectFilterChange}
        />
    );
    const nameSortDirection = sort?.key === "name" ? sort.direction : null;
    const columnsSortDirection =
        sort?.key === "columns" ? sort.direction : null;
    const documentsSortDirection =
        sort?.key === "documents" ? sort.direction : null;
    const createdSortDirection =
        sort?.key === "created" ? sort.direction : null;
    const nameFilterButton = (
        <TableFilters
            label="Sort by review name"
            value={nameSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            align="right"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("name", direction)}
        />
    );
    const columnsFilterButton = (
        <TableFilters
            label="Sort by columns"
            value={columnsSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("columns", direction)}
        />
    );
    const documentsFilterButton = (
        <TableFilters
            label="Sort by documents"
            value={documentsSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("documents", direction)}
        />
    );
    const createdFilterButton = (
        <TableFilters
            label="Sort by created date"
            value={createdSortDirection}
            allLabel="Default Order"
            widthClassName="w-40"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange("created", direction)}
        />
    );

    const toolbarActions =
        selectedIds.length > 0 ? (
            <NativeActionSelect
                label="Actions"
                items={[
                    {
                        label: "Delete",
                        onSelect: handleDeleteSelected,
                    },
                ]}
                triggerClassName="h-8 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 hover:bg-gray-100"
            >
                <>
                    Actions
                    <ChevronDown className="h-3.5 w-3.5" />
                </>
            </NativeActionSelect>
        ) : undefined;

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {/* Page header */}
            <PageHeader
                loading={loading}
                actions={[
                    {
                        type: "search",
                        value: search,
                        onChange: setSearch,
                        placeholder: "Search reviews…",
                    },
                    {
                        type: "new",
                        onClick: () => setNewTROpen(true),
                        loading: creating,
                        title: "New tabular review",
                    },
                ]}
            >
                <h1 className="text-2xl font-medium font-serif text-gray-900">
                    Tabular Reviews
                </h1>
            </PageHeader>

            <TableToolbar
                items={REVIEW_SCOPES}
                active={activeScope}
                onChange={(scope) => {
                    setActiveScope(scope);
                    clearSelection();
                }}
                actions={toolbarActions}
            />

            {/* Table */}
            <TableScrollArea
                header={
                    <TableHeaderRow>
                        <TableStickyCell header>
                            {effectiveLoading ? (
                                <SkeletonDot className="mr-4" />
                            ) : (
                                <input
                                    type="checkbox"
                                    checked={allSelected}
                                    ref={(el) => {
                                        if (el) el.indeterminate = someSelected;
                                    }}
                                    onChange={toggleAll}
                                    className={TABLE_CHECKBOX_CLASS}
                                />
                            )}
                            <span className="mr-1">Name</span>
                            {!loading && nameFilterButton}
                        </TableStickyCell>
                        <TableHeaderCell className="ml-auto w-24">
                            <div className="flex items-center gap-1">
                                <span>Columns</span>
                                {!loading && columnsFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-24">
                            <div className="flex items-center gap-1">
                                <span>Documents</span>
                                {!loading && documentsFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-40">
                            <div className="flex items-center gap-1">
                                <span>Project</span>
                                {!loading && projectFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-32">
                            <div className="flex items-center gap-1">
                                <span>Created</span>
                                {!loading && createdFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-8" />
                    </TableHeaderRow>
                }
            >
                {effectiveLoading ? (
                    <TableBody>
                        {[1, 2, 3].map((i) => (
                            <TableRow
                                key={i}
                                interactive={false}
                            >
                                <TableStickyCell
                                    hover={false}
                                    bgClassName="bg-transparent"
                                >
                                    <SkeletonDot className="mr-4" />
                                    <SkeletonLine className="h-3.5 w-48" />
                                </TableStickyCell>
                                <TableCell className="ml-auto w-24">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-24">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-40">
                                    <SkeletonLine className="w-24" />
                                </TableCell>
                                <TableCell className="w-32">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="w-8" />
                            </TableRow>
                        ))}
                    </TableBody>
                ) : filtered.length === 0 ? (
                    <TableEmptyState>
                        {activeScope === "all" && !projectFilter ? (
                            <>
                                <TabularReviewSkeuoIcon className="mb-4 h-8 w-8" />
                                <p className="text-2xl font-medium font-serif text-gray-900">
                                    Tabular Reviews
                                </p>
                                <p className="mt-1 text-xs text-gray-400 max-w-xs text-left">
                                    Extract data from documents into tables
                                    using AI.
                                </p>
                                <PillButton
                                    tone="black"
                                    size="sm"
                                    onClick={() => setNewTROpen(true)}
                                    disabled={creating}
                                    className="mt-4 px-3"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    Create
                                </PillButton>
                            </>
                        ) : (
                            <p className="text-sm text-gray-400">
                                No reviews found
                            </p>
                        )}
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {filtered.map((review) => {
                            const projectName = review.project_id
                                ? projectNameById.get(review.project_id)
                                : null;
                            return (
                                <TableRow
                                    key={review.id}
                                    selected={selectedIds.includes(review.id)}
                                    onClick={() => {
                                        router.push(
                                            review.project_id
                                                ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                                                : `/tabular-reviews/${review.id}`,
                                        );
                                    }}
                                >
                                    <TablePrimaryCell
                                        selected={selectedIds.includes(
                                            review.id,
                                        )}
                                        onSelectionChange={() =>
                                            toggleOne(review.id)
                                        }
                                        label={
                                            review.title ?? "Untitled Review"
                                        }
                                    />
                                    <TableCell className="ml-auto w-24">
                                        {review.columns_config?.length ?? 0}
                                    </TableCell>
                                    <TableCell className="w-24">
                                        {review.document_count ?? 0}
                                    </TableCell>
                                    <TableCell className="w-40 pr-2">
                                        {projectName ? (
                                            projectName
                                        ) : (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell className="w-32">
                                        {review.created_at ? (
                                            formatDate(review.created_at)
                                        ) : (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                    <div
                                        className="w-8 shrink-0 flex justify-end"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <RowActions
                                            onEditDetails={() => {
                                                requestReviewDetails(review);
                                            }}
                                            onDelete={async () => {
                                                if (
                                                    user?.id &&
                                                    review.user_id !== user.id
                                                ) {
                                                    setOwnerOnlyAction(
                                                        "delete this tabular review",
                                                    );
                                                    return;
                                                }
                                                await deleteTabularReview(
                                                    review.id,
                                                );
                                                setReviews((prev) =>
                                                    prev.filter(
                                                        (r) =>
                                                            r.id !== review.id,
                                                    ),
                                                );
                                            }}
                                            />
                                    </div>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                )}
            </TableScrollArea>

            <NewTRModal
                open={newTROpen}
                onClose={() => setNewTROpen(false)}
                onAdd={handleNewReview}
                projects={projects}
            />

            <TabularReviewDetailsModal
                open={!!detailsReview}
                review={detailsReview}
                projects={projects}
                canEdit={
                    !!detailsReview &&
                    (!user?.id || detailsReview.user_id === user.id)
                }
                onClose={() => setDetailsReview(null)}
                onSave={handleDetailsSave}
            />

            <OwnerOnlyPopup
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>
    );
}

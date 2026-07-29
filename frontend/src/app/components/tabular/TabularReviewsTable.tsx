"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    useMemo,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import { Plus } from "lucide-react";
import type { Project, TabularReview } from "@/app/components/shared/types";
import { RowActions } from "@/app/components/shared/RowActions";
import { TabularReviewSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import {
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
    TableSelectionPlaceholder,
    TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS,
    type TableSortDirection,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { CheckboxControl } from "@/app/components/ui/checkbox";
import { PillButton } from "@/app/components/ui/pill-button";import { formatDate, sortRows } from "@/app/lib/utils";type ReviewSortKey = "name" | "columns" | "documents" | "created";
const SORT_OPTIONS: TableFilterOption<TableSortDirection>[] = [
    { value: "asc", label: "Ascending" },
    { value: "desc", label: "Descending" },
];
const REVIEW_COLUMN = {
    columns: "hidden w-24 md:flex",
    documents: "hidden w-28 xl:flex",
    project: "hidden w-40 lg:flex",
    created: "hidden w-32 xl:flex",
    actions: "w-7 sm:w-8",
} as const;
export function TabularReviewsTable({
    reviews,
    filteredReviews,
    selectedReviewIds,
    setSelectedReviewIds,
    creatingReview,
    createDisabled = false,
    projects,
    projectFilter = null,
    onProjectFilterChange,
    reviewHref,
    onCreateReview,
    onOpenDetails,
    onDeleteReview,
    loading = false,
}: {
    reviews: TabularReview[];
    filteredReviews: TabularReview[];
    selectedReviewIds: string[];
    setSelectedReviewIds: Dispatch<SetStateAction<string[]>>;
    creatingReview: boolean;
    createDisabled?: boolean;
    projects?: Project[];
    projectFilter?: string | null;
    onProjectFilterChange?: (value: string | null) => void;
    reviewHref: (review: TabularReview) => string;
    onCreateReview: () => void;
    onOpenDetails: (review: TabularReview) => void;
    onDeleteReview: (review: TabularReview) => Promise<void> | void;
    loading?: boolean;
}) {
    const router = useRouter();
    const [sort, setSort] = useState<{
        key: ReviewSortKey;
        direction: TableSortDirection;
    } | null>(null);    const showProject = projects !== undefined;    const projectNameById = projects        ? new Map(projects.map((project) => [project.id, project.name]))        : null;    const visibleReviews = useMemo(() => {
        if (!sort) return filteredReviews;
        return sortRows(filteredReviews, (a, b) => {            if (sort.key === "columns") {                return (                    ((a.columns_config?.length ?? 0) -                        (b.columns_config?.length ?? 0))                );            }            if (sort.key === "documents") {                return (a.document_count ?? 0) - (b.document_count ?? 0);            }            if (sort.key === "created") {                return (                    (new Date(a.created_at).getTime() -                        new Date(b.created_at).getTime())                );            }            return (a.title ?? "Untitled Review").localeCompare(                b.title ?? "Untitled Review",            );        }, sort.direction);    }, [filteredReviews, sort]);
    const allSelected =
        visibleReviews.length > 0 &&
        visibleReviews.every((review) =>
            selectedReviewIds.includes(review.id),
        );
    const someSelected =
        !allSelected &&
        visibleReviews.some((review) =>
            selectedReviewIds.includes(review.id),
        );
    function handleSortChange(
        key: ReviewSortKey,
        direction: TableSortDirection | null,
    ) {
        setSort(direction ? { key, direction } : null);
        setSelectedReviewIds([]);
    }
    const sortFilter = (key: ReviewSortKey, label: string) => (
        <TableFilters
            label={label}
            value={sort?.key === key ? sort.direction : null}
            allLabel="Default Order"
            options={SORT_OPTIONS}
            onChange={(direction) => handleSortChange(key, direction)}
        />
    );
    const rowPadding = showProject ? undefined : "pr-8 md:pr-8";
    return (
        <TableScrollArea
            header={
                <TableHeaderRow className={rowPadding}>
                    <TableStickyCell
                        header
                        widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                    >
                        {loading ? (
                            <TableSelectionPlaceholder />
                        ) : (
                            <CheckboxControl
                                checked={allSelected}
                                ref={(element) => {
                                    if (element)
                                        element.indeterminate = someSelected;
                                }}
                                onChange={() =>
                                    setSelectedReviewIds(
                                        allSelected
                                            ? []
                                            : visibleReviews.map(
                                                  (review) => review.id,
                                              ),
                                    )
                                }
                                className="-ml-2 mr-1"
                            />
                        )}
                        <span className="mr-1">Name</span>
                        {sortFilter("name", "Sort by review name")}
                    </TableStickyCell>
                    <TableHeaderCell
                        className={`ml-auto ${REVIEW_COLUMN.columns}`}
                    >
                        <div className="flex items-center gap-1">
                            <span>Columns</span>
                            {sortFilter("columns", "Sort by columns")}
                        </div>
                    </TableHeaderCell>
                    <TableHeaderCell className={REVIEW_COLUMN.documents}>
                        <div className="flex items-center gap-1">
                            <span>Documents</span>
                            {sortFilter("documents", "Sort by documents")}
                        </div>
                    </TableHeaderCell>
                    {showProject && (
                        <TableHeaderCell className={REVIEW_COLUMN.project}>
                            <div className="flex items-center gap-1">
                                <span>Project</span>
                                <TableFilters
                                    label="Filter by project"
                                    searchable
                                    value={projectFilter}
                                    allLabel="All Projects"
                                    options={projects.map((project) => ({
                                        value: project.id,
                                        label: project.name,
                                    }))}
                                    onChange={(value) =>
                                        onProjectFilterChange?.(value)
                                    }
                                />
                            </div>
                        </TableHeaderCell>
                    )}
                    <TableHeaderCell className={REVIEW_COLUMN.created}>
                        <div className="flex items-center gap-1">
                            <span>Created</span>
                            {sortFilter("created", "Sort by created date")}
                        </div>
                    </TableHeaderCell>
                    <TableHeaderCell className={REVIEW_COLUMN.actions} />
                </TableHeaderRow>
            }
        >
            {loading ? (
                <LoadingRows showProject={showProject} />
            ) : reviews.length === 0 ? (
                <TableEmptyState>
                    <TabularReviewSkeuoIcon className="mb-4 h-8 w-8" />
                    <p className="font-serif text-2xl font-medium text-gray-900">
                        Tabular Reviews
                    </p>
                    <p className="mt-1 max-w-xs text-xs text-gray-400">
                        Extract data from documents into tables using AI.
                    </p>
                    <PillButton
                        tone="black"
                        size="sm"
                        onClick={onCreateReview}
                        disabled={creatingReview || createDisabled}
                        className="mt-4 px-3"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Create
                    </PillButton>
                </TableEmptyState>
            ) : visibleReviews.length === 0 ? (
                <TableEmptyState>
                    <p className="text-sm text-gray-400">No reviews found</p>
                </TableEmptyState>
            ) : (
                <TableBody>
                    {visibleReviews.map((review) => {
                        const href = reviewHref(review);
                        const projectName = review.project_id
                            ? projectNameById?.get(review.project_id)
                            : null;
                        return (
                            <TableRow
                                key={review.id}
                                selected={selectedReviewIds.includes(review.id)}
                                onClick={() => router.push(href)}
                                className={rowPadding}
                            >
                                <TablePrimaryCell
                                    selected={selectedReviewIds.includes(
                                        review.id,
                                    )}
                                    widthClassName={
                                        TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS
                                    }
                                    onSelectionChange={() =>
                                        setSelectedReviewIds((selected) =>
                                            selected.includes(review.id)
                                                ? selected.filter(
                                                      (id) => id !== review.id,
                                                  )
                                                : [...selected, review.id],
                                        )
                                    }
                                    label={
                                        <Link
                                            href={href}
                                            prefetch
                                            onClick={(event) =>
                                                event.stopPropagation()
                                            }
                                        >
                                            {review.title ?? "Untitled Review"}
                                        </Link>
                                    }
                                />
                                <TableCell
                                    className={`ml-auto ${REVIEW_COLUMN.columns}`}
                                >
                                    {review.columns_config?.length ?? 0}
                                </TableCell>
                                <TableCell className={REVIEW_COLUMN.documents}>
                                    {review.document_count ?? 0}
                                </TableCell>
                                {showProject && (
                                    <TableCell
                                        className={`${REVIEW_COLUMN.project} pr-2`}
                                    >
                                        {projectName ?? (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                )}
                                <TableCell className={REVIEW_COLUMN.created}>
                                    {review.created_at ? (
                                        formatDate(review.created_at)
                                    ) : (
                                        <span className="text-gray-300">—</span>
                                    )}
                                </TableCell>
                                <div
                                    className={`flex ${REVIEW_COLUMN.actions} shrink-0 justify-end`}
                                    onClick={(event) => event.stopPropagation()}
                                >
                                    <RowActions
                                        onEditDetails={() =>
                                            onOpenDetails(review)
                                        }
                                        onDelete={() => onDeleteReview(review)}
                                    />
                                </div>
                            </TableRow>
                        );
                    })}
                </TableBody>
            )}
        </TableScrollArea>
    );
}
function LoadingRows({ showProject }: { showProject: boolean }) {
    const titleWidths = showProject
        ? ["w-48", "w-48", "w-48"]
        : ["w-36", "w-40", "w-44", "w-48", "w-52"];
    const rowPadding = showProject ? undefined : "pr-8 md:pr-8";
    return (
        <TableBody>
            {titleWidths.map((titleWidth, index) => (
                <TableRow
                    key={index}
                    interactive={false}
                    className={rowPadding}
                >
                    <TableStickyCell
                        hover={false}
                        widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                        bgClassName={
                            showProject ? "bg-transparent" : undefined
                        }
                    >
                        <div className="flex min-w-0 items-center">
                            <TableSelectionPlaceholder />
                            <SkeletonLine
                                className={`h-3.5 ${titleWidth}`}
                            />
                        </div>
                    </TableStickyCell>
                    <TableCell
                        className={`ml-auto ${REVIEW_COLUMN.columns}`}
                    >
                        <SkeletonLine className="w-8" />
                    </TableCell>
                    <TableCell className={REVIEW_COLUMN.documents}>
                        <SkeletonLine className="w-8" />
                    </TableCell>
                    {showProject && (
                        <TableCell className={REVIEW_COLUMN.project}>
                            <SkeletonLine className="w-24" />
                        </TableCell>
                    )}
                    <TableCell className={REVIEW_COLUMN.created}>
                        <SkeletonLine className="w-20" />
                    </TableCell>
                    <TableCell className={REVIEW_COLUMN.actions} />
                </TableRow>
            ))}
        </TableBody>
    );
}

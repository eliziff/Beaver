import { Link, useNavigate } from "react-router-dom";
import { type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { Project } from "@/app/lib/api/projects";
import type { TabularReview } from "@/app/lib/api/tabular";
import { RowActions } from "@/app/components/shared/RowActions";
import { TabularReviewSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import {
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableLoadingState,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    TableSelectionHeader,
    TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS,
    useTableSelection,
} from "@/app/components/shared/TablePrimitive";
import { formatDate } from "@/app/lib/utils";
const REVIEW_COLUMN = {
    columns: "hidden w-24 md:flex",
    documents: "hidden w-28 xl:flex",
    project: "hidden w-40 lg:flex",
    created: "hidden w-32 xl:flex",
    actions: "w-7 sm:w-8",
} as const;
const EMPTY_VALUE = <span className="text-gray-300">—</span>;
/** The metadata columns, so the header cells and the row cells cannot drift apart. */
const REVIEW_COLUMNS: {
    key: string;
    header: ReactNode;
    headerClassName: string;
    cellClassName: string;
    needsProjects?: true;
    value: (review: TabularReview, projectName: string | null | undefined) => ReactNode;
}[] = [
    { key: "columns", header: "Columns",
        headerClassName: `ml-auto ${REVIEW_COLUMN.columns}`,
        cellClassName: `ml-auto ${REVIEW_COLUMN.columns}`,
        value: (review) => review.columns_config?.length ?? 0 },
    { key: "documents", header: "Documents",
        headerClassName: REVIEW_COLUMN.documents,
        cellClassName: REVIEW_COLUMN.documents,
        value: (review) => review.document_count ?? 0 },
    { key: "project", header: <span>Project</span>, needsProjects: true,
        headerClassName: REVIEW_COLUMN.project,
        cellClassName: `${REVIEW_COLUMN.project} pr-2`,
        value: (_review, projectName) => projectName ?? EMPTY_VALUE },
    { key: "created", header: "Created",
        headerClassName: REVIEW_COLUMN.created,
        cellClassName: REVIEW_COLUMN.created,
        value: (review) => review.created_at ? formatDate(review.created_at) : EMPTY_VALUE },
];
export function TabularReviewsTable({
    reviews,
    filteredReviews,
    selectedReviewIds,
    setSelectedReviewIds,
    projects,
    reviewHref,
    onOpenDetails,
    onDeleteReview,
    onDeleteSelected,
    loading = false,
}: {
    reviews: TabularReview[];
    filteredReviews: TabularReview[];
    selectedReviewIds: string[];
    setSelectedReviewIds: Dispatch<SetStateAction<string[]>>;
    projects?: Project[];
    reviewHref: (review: TabularReview) => string;
    onOpenDetails: (review: TabularReview) => void;
    onDeleteReview: (review: TabularReview) => Promise<void> | void;
    onDeleteSelected: () => void;
    loading?: boolean;
}) {
    const navigate = useNavigate();
    const showProject = projects !== undefined;
    const projectNameById = projects
        ? new Map(projects.map((project) => [project.id, project.name]))
        : null;
    const visibleReviews = filteredReviews;
    const selection = useTableSelection(
        visibleReviews, selectedReviewIds, setSelectedReviewIds);
    const rowPadding = showProject ? undefined : "pr-8 md:pr-8";
    const columns = REVIEW_COLUMNS.filter(
        ({ needsProjects }) => showProject || !needsProjects);
    return (
        <TableScrollArea
            header={<TableSelectionHeader className={rowPadding}
                widthClassName={TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS}
                selection={selection} selectionLabel="Select loaded reviews"
                loading={loading}
                label={selectedReviewIds.length
                    ? <span className="text-sm font-medium text-gray-800">
                        {selectedReviewIds.length} selected
                    </span>
                    : "Name"}>
                {selectedReviewIds.length ? (
                    <RowActions toolbar label="Actions" onDelete={onDeleteSelected} />
                ) : <>
                    {columns.map(({ key, header, headerClassName }) => (
                        <TableHeaderCell key={key} className={headerClassName}>
                            {header}
                        </TableHeaderCell>
                    ))}
                    <TableHeaderCell className={REVIEW_COLUMN.actions} />
                </>}
            </TableSelectionHeader>}
        >
            {loading ? (
                <TableLoadingState />
            ) : reviews.length === 0 ? (
                <TableEmptyState>
                    <TabularReviewSkeuoIcon className="mb-4 h-8 w-8" />
                    <p className="font-serif text-2xl font-medium text-gray-900">
                        No reviews yet
                    </p>
                    <p className="mt-1 max-w-xs text-xs text-gray-600">
                        Extract data from documents into tables using AI.
                    </p>
                </TableEmptyState>
            ) : visibleReviews.length === 0 ? (
                <TableEmptyState>
                    <p className="text-sm text-gray-600">No reviews found</p>
                </TableEmptyState>
            ) : (
                <TableBody>
                    {visibleReviews.map((review) => {
                        const href = reviewHref(review);
                        const projectName = review.project_id
                            ? review.project_name ?? projectNameById?.get(review.project_id)
                            : null;
                        return (
                            <TableRow
                                key={review.id}
                                selected={selection.selected.has(review.id)}
                                onClick={() => navigate(href)}
                                className={rowPadding}
                            >
                                <TablePrimaryCell
                                    selected={selection.selected.has(review.id)}
                                    widthClassName={
                                        TABLE_COMPACT_PRIMARY_CELL_WIDTH_CLASS
                                    }
                                    onSelectionChange={() => selection.toggle(review.id)}
                                    checkboxTitle={`Select ${review.title ?? "Untitled Review"}`}
                                    label={
                                        <Link
                                            to={href}
                                            onClick={(event) =>
                                                event.stopPropagation()
                                            }
                                        >
                                            {review.title ?? "Untitled Review"}
                                        </Link>
                                    }
                                />
                                {columns.map(({ key, cellClassName, value }) => (
                                    <TableCell key={key} className={cellClassName}>
                                        {value(review, projectName)}
                                    </TableCell>
                                ))}
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

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
const ACTIONS_COLUMN = "w-7 sm:w-8";
const EMPTY_VALUE = <span className="text-gray-300">—</span>;
/** The metadata columns, so the header cells and the row cells cannot drift apart. */
const REVIEW_COLUMNS: {
    key: string;
    header: ReactNode;
    className: string;
    /** Only where the row cell needs more than the shared column class. */
    cellClassName?: string;
    needsProjects?: true;
    value: (review: TabularReview, projectName: string | null | undefined) => ReactNode;
}[] = [
    { key: "columns", header: "Columns", className: "ml-auto hidden w-24 md:flex",
        value: (review) => review.columns_config?.length ?? 0 },
    { key: "documents", header: "Documents", className: "hidden w-28 xl:flex",
        value: (review) => review.document_count ?? 0 },
    { key: "project", header: <span>Project</span>, needsProjects: true,
        className: "hidden w-40 lg:flex", cellClassName: "hidden w-40 lg:flex pr-2",
        value: (_review, projectName) => projectName ?? EMPTY_VALUE },
    { key: "created", header: "Created", className: "hidden w-32 xl:flex",
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
    const selection = useTableSelection(
        filteredReviews, selectedReviewIds, setSelectedReviewIds);
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
                    {columns.map(({ key, header, className }) => (
                        <TableHeaderCell key={key} className={className}>
                            {header}
                        </TableHeaderCell>
                    ))}
                    <TableHeaderCell className={ACTIONS_COLUMN} />
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
            ) : filteredReviews.length === 0 ? (
                <TableEmptyState>
                    <p className="text-sm text-gray-600">No reviews found</p>
                </TableEmptyState>
            ) : (
                <TableBody>
                    {filteredReviews.map((review) => {
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
                                {columns.map(({ key, className, cellClassName, value }) => (
                                    <TableCell key={key} className={cellClassName ?? className}>
                                        {value(review, projectName)}
                                    </TableCell>
                                ))}
                                <div
                                    className={`flex ${ACTIONS_COLUMN} shrink-0 justify-end`}
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

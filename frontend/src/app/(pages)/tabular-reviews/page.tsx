import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { OwnerOnlyPopup } from "@/app/components/popups/OwnerOnlyPopup";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import type {
    ColumnConfig,
    Project,
    TabularReview,
} from "@/app/components/shared/types";
import { NewTRModal } from "@/app/components/tabular/NewTRModal";
import { TabularReviewDetailsModal } from "@/app/components/tabular/TabularReviewDetailsModal";
import { TabularReviewsTable } from "@/app/components/tabular/TabularReviewsTable";
import { ActionMenu } from "@/app/components/ui/action-menu";
import { useAuth } from "@/app/contexts/AuthContext";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
import {
    createTabularReview,
    deleteTabularReview,
    listTabularReviews,
    updateTabularReview,
} from "@/app/lib/beaverApi";

type ReviewScope = "all" | "in-project" | "standalone";
type ProjectContext = {
    creatingReview: boolean;
    openNewReview: () => void;
    project: Project | null;
    projectId: string;
    search: string;
    setOwnerOnlyAction: (action: string | null) => void;
};

const REVIEW_SCOPES: { id: ReviewScope; label: string }[] = [
    { id: "all", label: "All" },
    { id: "in-project", label: "In Project" },
    { id: "standalone", label: "Standalone" },
];

export default function TabularReviewsPage() {
    return <ReviewCollection />;
}

export function ProjectTabularReviewsPage() {
    const {
        creatingReview,
        openNewReview,
        project,
        projectId,
        search,
        setOwnerOnlyAction,
    } = useProjectWorkspace();
    return (
        <ReviewCollection
            projectContext={{
                creatingReview,
                openNewReview,
                project: project ?? null,
                projectId,
                search,
                setOwnerOnlyAction,
            }}
        />
    );
}

function ReviewCollection({ projectContext }: { projectContext?: ProjectContext }) {
    const navigate = useNavigate();
    const { user } = useAuth();
    const [creating, setCreating] = useState(false);
    const [newReviewOpen, setNewReviewOpen] = useState(false);
    const [detailsReview, setDetailsReview] = useState<TabularReview | null>(null);
    const [scope, setScope] = useState<ReviewScope>("all");
    const [search, setSearch] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const projectId = projectContext?.projectId;
    const query = projectContext?.search ?? search;
    const page = usePagedQuery<TabularReview>(
        (cursor, signal) => listTabularReviews({
            cursor,
            q: query,
            ...(projectId ? { project_id: projectId } : { scope }),
        }, signal),
        [projectId, query, scope],
    );
    const reviews = page.items;
    const loading = page.loading && reviews.length === 0;
    const creatingReview = projectContext?.creatingReview ?? creating;
    const reportOwnerOnly = projectContext?.setOwnerOnlyAction ?? setOwnerOnlyAction;

    useEffect(() => setSelectedIds([]), [query, scope]);

    function owns(review: TabularReview) {
        return !user?.id || review.user_id === user.id;
    }

    function openDetails(review: TabularReview) {
        if (!owns(review)) {
            reportOwnerOnly("edit tabular review details");
            return;
        }
        setDetailsReview(review);
    }

    async function saveDetails(values: {
        title: string;
        projectId?: string | null;
    }) {
        if (!detailsReview || !owns(detailsReview)) return;
        const updated = await updateTabularReview(detailsReview.id, {
            title: values.title,
            project_id: projectId ?? values.projectId ?? null,
        });
        page.setItems((current) => current.map((review) =>
            review.id === updated.id ? { ...review, ...updated } : review
        ));
        setDetailsReview((current) =>
            current?.id === updated.id ? { ...current, ...updated } : current
        );
    }

    async function removeReview(review: TabularReview) {
        if (!owns(review)) {
            reportOwnerOnly("delete this tabular review");
            return;
        }
        await deleteTabularReview(review.id);
        page.setItems((current) => current.filter(({ id }) => id !== review.id));
    }

    async function removeSelected() {
        const selected = new Set(selectedIds);
        const owned = reviews.filter((review) =>
            selected.has(review.id) && owns(review)
        );
        setSelectedIds([]);
        await Promise.all(owned.map(({ id }) =>
            deleteTabularReview(id).catch(() => undefined)
        ));
        const removed = new Set(owned.map(({ id }) => id));
        page.setItems((current) => current.filter(({ id }) => !removed.has(id)));
        const blocked = selected.size - owned.length;
        if (blocked > 0) {
            reportOwnerOnly(
                `delete ${blocked} of the selected reviews - only the review creator can delete a review`,
            );
        }
    }

    async function createReview(
        title: string,
        selectedProjectId?: string,
        documentIds?: string[],
        columnsConfig?: ColumnConfig[] | null,
    ) {
        setCreating(true);
        try {
            const review = await createTabularReview({
                title,
                document_ids: documentIds ?? [],
                columns_config: columnsConfig ?? [],
                ...(selectedProjectId ? { project_id: selectedProjectId } : {}),
            });
            navigate(selectedProjectId
                ? `/projects/${selectedProjectId}/tabular-reviews/${review.id}`
                : `/tabular-reviews/${review.id}`
            );
        } finally {
            setCreating(false);
        }
    }

    const selectionActions = (
        <span className="inline-flex h-8 w-28">
            {selectedIds.length > 0 && (
                <ActionMenu
                    label="Actions"
                    items={[{ label: "Delete", onSelect: removeSelected }]}
                    className="w-full"
                    triggerClassName="h-8 w-full items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 hover:bg-gray-100"
                >
                    Actions <span aria-hidden="true">&#9662;</span>
                </ActionMenu>
            )}
        </span>
    );

    const collection = (
        <>
            {projectContext ? (
                <ProjectSectionToolbar actions={selectionActions} />
            ) : (
                <>
                    <PageHeader
                        loading={loading}
                        actions={[
                            {
                                type: "search",
                                value: search,
                                onChange: setSearch,
                                placeholder: "Search reviews...",
                            },
                            {
                                type: "new",
                                onClick: () => setNewReviewOpen(true),
                                loading: creating,
                                title: "New tabular review",
                            },
                        ]}
                    >
                        <h1 className="font-serif text-2xl font-medium text-gray-900">
                            Tabular Reviews
                        </h1>
                    </PageHeader>
                    <TableToolbar
                        items={REVIEW_SCOPES}
                        active={scope}
                        onChange={setScope}
                        actions={selectionActions}
                    />
                </>
            )}
            <TabularReviewsTable
                reviews={reviews}
                filteredReviews={reviews}
                selectedReviewIds={selectedIds}
                setSelectedReviewIds={setSelectedIds}
                creatingReview={creatingReview}
                projects={[]}
                reviewHref={(review) => review.project_id
                    ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                    : `/tabular-reviews/${review.id}`
                }
                onCreateReview={projectContext?.openNewReview ?? (() => setNewReviewOpen(true))}
                onOpenDetails={openDetails}
                onDeleteReview={removeReview}
                loading={loading}
            />
            {page.hasMore && (
                <button
                    type="button"
                    onClick={() => void page.loadMore()}
                    disabled={page.loading}
                    className="mx-auto my-2 min-h-9 rounded-md border border-gray-300 px-4 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                    {page.loading ? "Loading…" : "Load more"}
                </button>
            )}
            {!projectContext && (
                <NewTRModal
                    open={newReviewOpen}
                    onClose={() => setNewReviewOpen(false)}
                    onAdd={createReview}
                />
            )}
            <TabularReviewDetailsModal
                open={!!detailsReview}
                review={detailsReview}
                projects={projectContext?.project ? [projectContext.project] : []}
                canEdit={!!detailsReview && owns(detailsReview)}
                lockProject={!!projectContext}
                onClose={() => setDetailsReview(null)}
                onSave={saveDetails}
            />
            {!projectContext && (
                <OwnerOnlyPopup
                    open={!!ownerOnlyAction}
                    action={ownerOnlyAction ?? undefined}
                    onClose={() => setOwnerOnlyAction(null)}
                />
            )}
        </>
    );

    return projectContext ? collection : (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {collection}
        </div>
    );
}

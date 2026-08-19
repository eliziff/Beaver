import { useEffect, useState } from "react";
import {
    deleteTabularReview,
    listTabularReviews,
    updateTabularReview,
} from "@/app/lib/beaverApi";
import { TabularReviewsTable } from "@/app/components/tabular/TabularReviewsTable";
import { TabularReviewDetailsModal } from "@/app/components/tabular/TabularReviewDetailsModal";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";
import type { TabularReview } from "@/app/components/shared/types";
import { useAuth } from "@/app/contexts/AuthContext";
import { NativeActionSelect } from "@/app/components/ui/native-action-select";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
export default function ProjectTabularReviewsPage() {
    const { user } = useAuth();
    const {
        creatingReview,
        openNewReview,
        project,
        projectId,
        search,
        setOwnerOnlyAction,
    } = useProjectWorkspace();
    const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);
    const [detailsReview, setDetailsReview] = useState<TabularReview | null>(
        null,
    );
    const page = usePagedQuery<TabularReview>(
        (cursor, signal) => listTabularReviews({
            project_id: projectId, q: search, cursor,
        }, signal),
        [projectId, search],
    );
    const reviews = page.items;
    const filteredReviews = reviews;
    const loading = page.loading && reviews.length === 0;
    useEffect(() => setSelectedReviewIds([]), [search]);
    function handleOpenDetails(review: TabularReview) {
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
        const updated = await updateTabularReview(detailsReview.id, {
            title: values.title,
            project_id: projectId,
        });
        page.setItems((prev) =>
            prev.map((review) =>
                review.id === updated.id ? updated : review,
            ),
        );
        setDetailsReview(updated);
    }
    async function handleDeleteReviewRow(review: TabularReview) {
        if (user?.id && review.user_id !== user.id) {
            setOwnerOnlyAction("delete this tabular review");
            return;
        }
        await deleteTabularReview(review.id);
        page.setItems((prev) =>
            prev.filter((r) => r.id !== review.id),
        );
    }
    async function handleDeleteSelectedReviews() {
        const ids = [...selectedReviewIds];
        const owned = ids.filter((id) => {
            const review = reviews.find((r) => r.id === id);
            return !review || !user?.id || review.user_id === user?.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedReviewIds([]);
        await Promise.all(
            owned.map((id) => deleteTabularReview(id).catch(() => {})),
        );
        page.setItems((prev) =>
            prev.filter((review) => !owned.includes(review.id)),
        );
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected reviews - only the review creator can delete a review`,
            );
        }
    }
    const toolbarActions = (
        <span className="inline-flex h-8 w-28">
            {selectedReviewIds.length > 0 && (
                <NativeActionSelect
                    label="Actions"
                    items={[
                        {
                            label: "Delete",
                            onSelect: () =>
                                void handleDeleteSelectedReviews(),
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
        <>
            <ProjectSectionToolbar actions={toolbarActions} />
            <TabularReviewsTable
                reviews={reviews}
                filteredReviews={filteredReviews}
                selectedReviewIds={selectedReviewIds}
                creatingReview={creatingReview}
                loading={loading}
                onCreateReview={openNewReview}
                reviewHref={(review) =>
                    `/projects/${projectId}/tabular-reviews/${review.id}`
                }
                onOpenDetails={handleOpenDetails}
                onDeleteReview={handleDeleteReviewRow}
                setSelectedReviewIds={setSelectedReviewIds}
            />
            {page.hasMore && (
                <button type="button" onClick={() => void page.loadMore()}
                    disabled={page.loading}
                    className="mx-auto my-2 min-h-9 rounded-md border border-gray-300 px-4 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50">
                    {page.loading ? "Loading…" : "Load more"}
                </button>
            )}
            <TabularReviewDetailsModal
                open={!!detailsReview}
                review={detailsReview}
                projects={project ? [project] : []}
                canEdit={
                    !!detailsReview &&
                    (!user?.id || detailsReview.user_id === user.id)
                }
                lockProject
                onClose={() => setDetailsReview(null)}
                onSave={handleDetailsSave}
            />
        </>
    );
}

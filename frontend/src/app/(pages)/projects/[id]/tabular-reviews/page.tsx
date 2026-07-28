"use client";

import { use, useCallback, useEffect, useState } from "react";
import {
    deleteTabularReview,
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

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectTabularReviewsPage({ params }: Props) {
    use(params);
    const workspace = useProjectWorkspace();
    const { user } = useAuth();
    const {
        ensureProjectReviews,
        project,
        projectId,
        projectReviews,
        search,
        setOwnerOnlyAction,
        setProjectReviews,
    } = workspace;
    const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);
    const [detailsReview, setDetailsReview] = useState<TabularReview | null>(
        null,
    );
    const docs = project?.documents ?? [];
    const reviews = projectReviews ?? [];
    const loading = projectReviews === null;

    useEffect(() => {
        void ensureProjectReviews();
    }, [ensureProjectReviews]);

    const q = search.toLowerCase();
    const filteredReviews = q
        ? reviews.filter((r) =>
              (r.title ?? "").toLowerCase().includes(q),
          )
        : reviews;
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
        if (user?.id && detailsReview.user_id !== user.id) {
            setOwnerOnlyAction("edit tabular review details");
            return;
        }
        const updated = await updateTabularReview(detailsReview.id, {
            title: values.title,
            project_id: projectId,
        });
        setProjectReviews((prev) =>
            (prev ?? []).map((review) =>
                review.id === updated.id ? { ...review, ...updated } : review,
            ),
        );
        setDetailsReview((current) =>
            current?.id === updated.id ? { ...current, ...updated } : current,
        );
    }

    async function handleDeleteReviewRow(review: TabularReview) {
        if (user?.id && review.user_id !== user.id) {
            setOwnerOnlyAction("delete this tabular review");
            return;
        }
        await deleteTabularReview(review.id);
        setProjectReviews((prev) =>
            (prev ?? []).filter((r) => r.id !== review.id),
        );
    }

    const handleDeleteSelectedReviews = useCallback(async () => {
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
        setProjectReviews((prev) =>
            (prev ?? []).filter((review) => !owned.includes(review.id)),
        );
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected reviews - only the review creator can delete a review`,
            );
        }
    }, [
        reviews,
        selectedReviewIds,
        setOwnerOnlyAction,
        setProjectReviews,
        user?.id,
    ]);

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
                creatingReview={workspace.creatingReview}
                createDisabled={docs.length === 0}
                loading={loading}
                onCreateReview={workspace.openNewReview}
                reviewHref={(review) =>
                    `/projects/${projectId}/tabular-reviews/${review.id}`
                }
                onOpenDetails={handleOpenDetails}
                onDeleteReview={handleDeleteReviewRow}
                setSelectedReviewIds={setSelectedReviewIds}
            />
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

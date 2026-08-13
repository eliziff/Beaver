"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    createTabularReview,
    deleteTabularReview,
    listTabularReviews,
    updateTabularReview,
} from "@/app/lib/beaverApi";
import type {
    ColumnConfig,
    TabularReview,
} from "@/app/components/shared/types";
import { useAuth } from "@/app/contexts/AuthContext";
import { OwnerOnlyPopup } from "@/app/components/popups/OwnerOnlyPopup";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { NewTRModal } from "@/app/components/tabular/NewTRModal";
import { TabularReviewDetailsModal } from "@/app/components/tabular/TabularReviewDetailsModal";
import { TabularReviewsTable } from "@/app/components/tabular/TabularReviewsTable";
import { NativeActionSelect } from "@/app/components/ui/native-action-select";
import { usePagedQuery } from "@/app/hooks/usePagedQuery";
type ReviewScope = "all" | "in-project" | "standalone";
const REVIEW_SCOPES: { id: ReviewScope; label: string }[] = [
    { id: "all", label: "All" },
    { id: "in-project", label: "In Project" },
    { id: "standalone", label: "Standalone" },
];
export default function TabularReviewsPage() {
    const router = useRouter();
    const { user } = useAuth();
    const [creating, setCreating] = useState(false);
    const [newTROpen, setNewTROpen] = useState(false);
    const [detailsReview, setDetailsReview] = useState<TabularReview | null>(
        null,
    );
    const [activeScope, setActiveScope] = useState<ReviewScope>("all");
    const [search, setSearch] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const page = usePagedQuery<TabularReview>(
        (cursor, signal) => listTabularReviews({
            q: search,
            scope: activeScope,
            cursor,
        }, signal),
        [activeScope, search],
    );
    const reviews = page.items;
    const filteredReviews = reviews;
    const loading = page.loading && reviews.length === 0;
    useEffect(() => setSelectedIds([]), [activeScope, search]);
    async function handleNewReview(
        title: string,
        projectId?: string,
        documentIds?: string[],
        columnsConfig?: ColumnConfig[] | null,
    ) {
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
    }
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
        page.setItems((current) =>
            current.map((review) =>
                review.id === updated.id ? { ...review, ...updated } : review,
            ),
        );
        setDetailsReview((current) =>
            current?.id === updated.id ? { ...current, ...updated } : current,
        );
    }
    async function handleDeleteSelected() {
        const selected = new Set(selectedIds);
        const owned = reviews
            .filter((review) => selected.has(review.id))
            .filter(
                (review) => !user?.id || review.user_id === user.id,
            )
            .map((review) => review.id);
        const blocked = selected.size - owned.length;
        setSelectedIds([]);
        await Promise.all(
            owned.map((id) => deleteTabularReview(id).catch(() => {})),
        );
        page.setItems((current) =>
            current.filter((review) => !owned.includes(review.id)),
        );
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected reviews - only the review creator can delete a review`,
            );
        }
    }
    async function handleDeleteReview(review: TabularReview) {
        if (user?.id && review.user_id !== user.id) {
            setOwnerOnlyAction("delete this tabular review");
            return;
        }
        await deleteTabularReview(review.id);
        page.setItems((current) =>
            current.filter((candidate) => candidate.id !== review.id),
        );
    }
    const toolbarActions = (
        <span className="inline-flex h-8 w-28">
            {selectedIds.length > 0 && (
                <NativeActionSelect
                    label="Actions"
                    items={[
                        {
                            label: "Delete",
                            onSelect: handleDeleteSelected,
                        },
                    ]}
                    className="w-full"
                    triggerClassName="h-8 w-full items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 hover:bg-gray-100"
                >
                    Actions
                    <span aria-hidden="true">&#9662;</span>
                </NativeActionSelect>
            )}
        </span>
    );
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
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
                        onClick: () => setNewTROpen(true),
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
                active={activeScope}
                onChange={(scope) => {
                    setActiveScope(scope);
                    setSelectedIds([]);
                }}
                actions={toolbarActions}
            />
            <TabularReviewsTable
                reviews={reviews}
                filteredReviews={filteredReviews}
                selectedReviewIds={selectedIds}
                setSelectedReviewIds={setSelectedIds}
                creatingReview={creating}
                projects={[]}
                reviewHref={(review) =>
                    review.project_id
                        ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                        : `/tabular-reviews/${review.id}`
                }
                onCreateReview={() => setNewTROpen(true)}
                onOpenDetails={requestReviewDetails}
                onDeleteReview={handleDeleteReview}
                loading={loading}
            />
            {page.hasMore && (
                <button type="button" onClick={() => void page.loadMore()}
                    disabled={page.loading}
                    className="mx-auto my-2 min-h-9 rounded-md border border-gray-300 px-4 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50">
                    {page.loading ? "Loadingâ€¦" : "Load more"}
                </button>
            )}
            <NewTRModal
                open={newTROpen}
                onClose={() => setNewTROpen(false)}
                onAdd={handleNewReview}
            />
            <TabularReviewDetailsModal
                open={!!detailsReview}
                review={detailsReview}
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

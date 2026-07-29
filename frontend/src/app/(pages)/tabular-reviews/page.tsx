"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
    createTabularReview,
    deleteTabularReview,
    listProjects,
    listTabularReviews,
    updateTabularReview,
} from "@/app/lib/beaverApi";
import type {
    ColumnConfig,
    Project,
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
type ReviewScope = "all" | "in-project" | "standalone";
const REVIEW_SCOPES: { id: ReviewScope; label: string }[] = [
    { id: "all", label: "All" },
    { id: "in-project", label: "In Project" },
    { id: "standalone", label: "Standalone" },
];
export default function TabularReviewsPage() {
    const router = useRouter();
    const { user } = useAuth();
    const [reviews, setReviews] = useState<TabularReview[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [newTROpen, setNewTROpen] = useState(false);
    const [detailsReview, setDetailsReview] = useState<TabularReview | null>(
        null,
    );
    const [activeScope, setActiveScope] = useState<ReviewScope>("all");
    const [search, setSearch] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    useEffect(() => {
        Promise.all([
            listTabularReviews().catch(() => []),
            listProjects().catch(() => []),
        ])
            .then(([nextReviews, nextProjects]) => {
                setReviews(nextReviews);
                setProjects(nextProjects);
            })
            .finally(() => setLoading(false));
    }, []);
    const query = search.toLowerCase();
    const filteredReviews = useMemo(
        () =>
            reviews
                .filter((review) => {
                    if (activeScope === "in-project")
                        return !!review.project_id;
                    if (activeScope === "standalone")
                        return !review.project_id;
                    return true;
                })
                .filter(
                    (review) =>
                        !query ||
                        (review.title ?? "").toLowerCase().includes(query),
                ),
        [activeScope, query, reviews],
    );
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
        setReviews((current) =>
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
        setReviews((current) =>
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
        setReviews((current) =>
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
                projects={projects}
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

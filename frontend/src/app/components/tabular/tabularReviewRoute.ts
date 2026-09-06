import { createTabularReview } from "@/app/lib/api/tabular";

export const tabularReviewPath = (review: { id: string; project_id?: string | null }) =>
    `${review.project_id ? `/projects/${encodeURIComponent(review.project_id)}` : ""}/tabular-reviews/${encodeURIComponent(review.id)}`;

export async function createTabularReviewPath(
    payload: Parameters<typeof createTabularReview>[0],
) {
    const { id } = await createTabularReview(payload);
    return tabularReviewPath({ id, project_id: payload.project_id });
}

import { createTabularReview } from "@/app/lib/api/tabular";

export async function createTabularReviewPath(
    payload: Parameters<typeof createTabularReview>[0],
) {
    const { id } = await createTabularReview(payload);
    return `${payload.project_id ? `/projects/${payload.project_id}` : ""}/tabular-reviews/${id}`;
}

import { createTabularReview } from "@/app/lib/api/tabular";

/** An arranged table opens directly; an unarranged one shows its Organize composer in the empty table. */
export const workspaceTableRoute = (table: { id: string }) => `/tabular-reviews/${encodeURIComponent(table.id)}`;

export async function createTabularReviewPath(
    payload: Parameters<typeof createTabularReview>[0],
) {
    const { id } = await createTabularReview(payload);
    return `${payload.project_id ? `/projects/${payload.project_id}` : ""}/tabular-reviews/${id}`;
}

import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TabularReview } from "@/app/lib/api/tabular";
import { TabularReviewsTable } from "./TabularReviewsTable";

const review: TabularReview = {
    id: "review-1",
    project_id: "project-1",
    user_id: "user-1",
    title: "Disclosure",
    columns_config: [],
    workflow_id: null,
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-28T00:00:00.000Z",
};

describe("TabularReviewsTable", () => {
    it("selects visible reviews and runs their bulk action", () => {
        const setSelectedReviewIds = vi.fn();
        const onDeleteSelected = vi.fn();
        const props = { setSelectedReviewIds, onDeleteSelected,
            reviewHref: (item: TabularReview) => `/tabular-reviews/${item.id}`,
            onOpenDetails: vi.fn(), onDeleteReview: vi.fn(),
            reviews: [review], filteredReviews: [review] };
        const { rerender } = render(
            <TabularReviewsTable {...props} selectedReviewIds={[]} />, { wrapper: MemoryRouter },
        );

        fireEvent.click(screen.getByRole("checkbox", { name: "Select loaded reviews" }));
        expect(setSelectedReviewIds).toHaveBeenCalledWith([review.id]);

        rerender(<TabularReviewsTable {...props} selectedReviewIds={[review.id]} />);
        fireEvent.click(screen.getByRole("button", { name: "Actions" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
        expect(onDeleteSelected).toHaveBeenCalledOnce();
    });
});

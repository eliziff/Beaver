import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@/app/lib/api/projects";
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

const project: Project = {
    id: "project-1",
    user_id: "user-1",
    name: "Smith",
    cm_number: null,
    practice: null,
    shared_with: [],
    created_at: "2026-07-28T00:00:00.000Z",
};

function table(props: Partial<ComponentProps<typeof TabularReviewsTable>> = {}) {
    return <MemoryRouter><TabularReviewsTable
        reviews={[]} filteredReviews={[]} selectedReviewIds={[]}
        setSelectedReviewIds={vi.fn()} reviewHref={(item) => `/tabular-reviews/${item.id}`}
        onOpenDetails={vi.fn()} onDeleteReview={vi.fn()} onDeleteSelected={vi.fn()}
        {...props} /></MemoryRouter>;
}

describe("TabularReviewsTable", () => {
    it("selects visible reviews and runs their bulk action", () => {
        const setSelectedReviewIds = vi.fn();
        const onDeleteSelected = vi.fn();
        const props = { setSelectedReviewIds, onDeleteSelected,
            reviews: [review], filteredReviews: [review] };
        const { rerender } = render(table(props));

        fireEvent.click(screen.getByRole("checkbox", { name: "Select loaded reviews" }));
        expect(setSelectedReviewIds).toHaveBeenCalledWith([review.id]);

        rerender(table({ ...props, selectedReviewIds: [review.id] }));
        fireEvent.click(screen.getByRole("button", { name: "Actions" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
        expect(onDeleteSelected).toHaveBeenCalledOnce();
    });

    it("adds project data only to the global view", () => {
        const { rerender } = render(table({ loading: true }));

        expect(screen.queryByText("Project")).not.toBeInTheDocument();

        rerender(table({ loading: true, projects: [project] }));

        expect(screen.getByText("Project")).toBeInTheDocument();

        rerender(table({ reviews: [review], filteredReviews: [review], projects: [project] }));

        expect(screen.getByText("Smith")).toBeInTheDocument();
    });
});

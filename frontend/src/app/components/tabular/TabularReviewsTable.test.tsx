import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project, TabularReview } from "@/app/components/shared/types";
import { TabularReviewsTable } from "./TabularReviewsTable";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

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
    updated_at: "2026-07-28T00:00:00.000Z",
};

const handlers = {
    setSelectedReviewIds: vi.fn(),
    reviewHref: (item: TabularReview) => `/tabular-reviews/${item.id}`,
    onCreateReview: vi.fn(),
    onOpenDetails: vi.fn(),
    onDeleteReview: vi.fn(),
};

describe("TabularReviewsTable", () => {
    it("adds project data only globally and preserves each loading shell", () => {
        const { container, rerender } = render(
            <TabularReviewsTable
                reviews={[]}
                filteredReviews={[]}
                selectedReviewIds={[]}
                creatingReview={false}
                loading
                {...handlers}
            />,
        );

        expect(screen.queryByText("Project")).not.toBeInTheDocument();
        expect(container.querySelectorAll(".h-11.min-w-max")).toHaveLength(6);

        rerender(
            <TabularReviewsTable
                reviews={[]}
                filteredReviews={[]}
                selectedReviewIds={[]}
                creatingReview={false}
                loading
                projects={[project]}
                {...handlers}
            />,
        );

        expect(screen.getByText("Project")).toBeInTheDocument();
        expect(container.querySelectorAll(".h-11.min-w-max")).toHaveLength(4);

        rerender(
            <TabularReviewsTable
                reviews={[review]}
                filteredReviews={[review]}
                selectedReviewIds={[]}
                creatingReview={false}
                projects={[project]}
                {...handlers}
            />,
        );

        expect(screen.getByText("Smith")).toBeInTheDocument();
    });
});

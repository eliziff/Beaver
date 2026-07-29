import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { WorkflowPickerContent } from "./WorkflowPickerContent";

const workflow = (
    id: string,
    title: string,
    type: "assistant" | "tabular" = "assistant",
): Workflow => ({
    id,
    user_id: "user-1",
    metadata: {
        title,
        description: null,
        type,
        contributors: [],
        language: "English",
        version: null,
        practice: "Litigation",
        jurisdictions: ["Canada"],
    },
    skill_md: "# Lease analyzer\n\n## Instructions\n\nReview the lease.",
    columns_config: [],
    is_system: false,
    created_at: "2026-07-29T00:00:00.000Z",
});

beforeAll(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
});

it("filters and selects workflows without changing the list width", () => {
    const onSelect = vi.fn();
    const onSearchChange = vi.fn();
    const workflows = [
        workflow("lease", "Lease analyzer"),
        workflow("diligence", "Due diligence", "tabular"),
    ];
    const { container, rerender } = render(
        <WorkflowPickerContent
            workflows={workflows}
            selected={null}
            onSelect={onSelect}
            search=""
            onSearchChange={onSearchChange}
        />,
    );
    const list = container.querySelector('[class*="md:w-64"]');
    expect(list).toBeInTheDocument();
    fireEvent.click(
        screen.getByRole("button", { name: /Lease analyzer/ }),
    );
    expect(onSelect).toHaveBeenCalledWith(workflows[0]);

    fireEvent.change(screen.getByPlaceholderText("Search workflows..."), {
        target: { value: "lease" },
    });
    expect(onSearchChange).toHaveBeenCalledWith("lease");

    rerender(
        <WorkflowPickerContent
            workflows={workflows}
            selected={workflows[0]}
            onSelect={onSelect}
            search="lease"
            onSearchChange={onSearchChange}
        />,
    );
    expect(screen.getAllByText("Lease analyzer")).toHaveLength(2);
    expect(screen.queryByText("Due diligence")).not.toBeInTheDocument();
    expect(container.querySelector('[class*="md:w-64"]')).toBe(list);
    expect(screen.getByText("Instructions")).toBeInTheDocument();
    expect(screen.getByText("Review the lease.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(onSelect).toHaveBeenCalledWith(null);
});

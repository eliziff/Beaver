import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@/app/lib/api/projects";
import { ProjectChoiceList } from "./ProjectChoiceList";

const projects = [
    {
        id: "project-1",
        name: "Appeal",
        cm_number: "24-101",
    },
    {
        id: "project-2",
        name: "Acquisition",
        cm_number: null,
    },
] as Project[];

describe("ProjectChoiceList", () => {
    it("searches an unbounded project catalog without a select menu", () => {
        const onChange = vi.fn();
        render(
            <ProjectChoiceList
                projects={projects}
                value="project-1"
                onChange={onChange}
            />,
        );

        const selected = screen.getByRole("button", { name: /Appeal/ });
        const unselected = screen.getByRole("button", { name: /Acquisition/ });
        expect(selected).toHaveAttribute("aria-pressed", "true");
        expect(unselected).toHaveAttribute("aria-pressed", "false");

        fireEvent.change(screen.getByRole("searchbox"), {
            target: { value: "acq" },
        });
        expect(
            screen.queryByRole("button", { name: /Appeal/ }),
        ).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /Acquisition/ }));
        expect(onChange).toHaveBeenCalledWith("project-2");
    });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/app/components/shared/types";
import { ProjectsOverview } from "./ProjectsOverview";

const { deleteProject, listProjects, push } = vi.hoisted(() => ({
    deleteProject: vi.fn<(id: string) => Promise<void>>(),
    listProjects: vi.fn<() => Promise<Project[]>>(),
    push: vi.fn(),
}));

const createdProject: Project = {
    id: "project-new",
    user_id: "user-1",
    is_owner: true,
    name: "New appeal",
    cm_number: null,
    practice: "Litigation",
    shared_with: [],
    created_at: "2026-07-27T18:42:00.000Z",
    updated_at: "2026-07-27T18:42:00.000Z",
    document_count: 0,
    chat_count: 0,
    review_count: 0,
};

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "user-1", email: "user@example.test" },
        isAuthenticated: true,
        authLoading: false,
    }),
}));

vi.mock("@/app/lib/beaverApi", () => ({
    listProjects,
    updateProject: vi.fn(),
    deleteProject,
}));

vi.mock("./NewProjectModal", () => ({
    NewProjectModal: ({
        open,
        onClose,
        onCreated,
    }: {
        open: boolean;
        onClose: () => void;
        onCreated: (project: Project) => void;
    }) =>
        open ? (
            <button
                type="button"
                onClick={() => {
                    onCreated(createdProject);
                    onClose();
                }}
            >
                Complete project creation
            </button>
        ) : null,
}));

vi.mock("./ProjectDetailsModal", () => ({
    ProjectDetailsModal: () => null,
}));

vi.mock("@/app/components/popups/OwnerOnlyPopup", () => ({
    OwnerOnlyPopup: () => null,
}));

vi.mock("@/app/components/shared/RowActions", () => ({
    RowActions: () => <button aria-label="More actions" type="button" />,
}));

describe("ProjectsOverview", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        deleteProject.mockResolvedValue(undefined);
        listProjects.mockResolvedValue([]);
        Object.defineProperty(window, "matchMedia", {
            configurable: true,
            writable: true,
            value: vi.fn((query: string) => ({
                matches: true,
                media: query,
                onchange: null,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                addListener: vi.fn(),
                removeListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })),
        });
    });

    it("keeps search and one explicit create action visible", async () => {
        const { container } = render(<ProjectsOverview />);

        expect(
            await screen.findByRole("searchbox", { name: "Search projects" }),
        ).toBeVisible();
        const [createButton] = screen.getAllByRole("button", {
            name: "Create project +",
        });
        expect(createButton.querySelector("svg.lucide-folder")).not.toBeNull();
        expect(await screen.findByText("No projects")).toBeVisible();
        expect(container.querySelectorAll("svg.lucide-folder")).toHaveLength(2);
        expect(screen.queryByText(/Upload documents into projects/u)).not.toBeInTheDocument();
    });

    it("keeps the table shell stable while rows load", () => {
        listProjects.mockReturnValue(new Promise(() => {}));
        render(<ProjectsOverview />);

        expect(screen.getByRole("searchbox", { name: "Search projects" }))
            .toBeDisabled();
        expect(screen.queryByRole("combobox", { name: /sort|filter/i }))
            .not.toBeInTheDocument();
    });

    it("keeps the action slot mounted and deletes without a one-item menu", async () => {
        listProjects.mockResolvedValue([createdProject]);
        const { container } = render(<ProjectsOverview />);
        const slot = container.querySelector<HTMLSpanElement>(
            "span.inline-flex.h-8.w-28",
        );

        expect(slot).not.toBeNull();
        await screen.findByText(createdProject.name);
        fireEvent.click(screen.getAllByRole("checkbox")[1]);

        expect(container.querySelector("span.inline-flex.h-8.w-28")).toBe(slot);
        expect(
            screen.queryByRole("combobox", { name: "Actions" }),
        ).not.toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("button", { name: "Delete selected" }),
        );

        await waitFor(() =>
            expect(deleteProject).toHaveBeenCalledWith(createdProject.id),
        );
    });

    it("uses one bounded row and settles in two commits", async () => {
        listProjects.mockResolvedValue([createdProject]);
        const commits: string[] = [];
        const { container } = render(
            <Profiler
                id="projects"
                onRender={(_, phase) => commits.push(phase)}
            >
                <ProjectsOverview />
            </Profiler>,
        );

        const name = await screen.findByText(createdProject.name);
        expect(name.closest(".group")).toHaveClass(
            "h-14",
            "w-full",
            "min-w-0",
        );
        expect(container.querySelector(".min-w-max")).toBeNull();
        expect(commits).toEqual(["mount", "update"]);
    });

    it("displays the API creation timestamp without replacing it", async () => {
        const user = userEvent.setup();
        render(<ProjectsOverview />);

        await user.click(
            await screen.findByRole("button", { name: "Create project +" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Complete project creation" }),
        );

        const formattedDate = new Date(
            createdProject.created_at,
        ).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
        });
        expect(await screen.findByText("New appeal")).toBeVisible();
        expect(screen.getByText(formattedDate)).toBeVisible();
        expect(push).toHaveBeenCalledWith("/projects/project-new");
    });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/app/components/shared/types";
import { ProjectsOverview } from "./ProjectsOverview";

const { deleteProject, listProjects, push } = vi.hoisted(() => ({
    deleteProject: vi.fn<(id: string) => Promise<void>>(),
    listProjects: vi.fn(),
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

vi.mock("react-router-dom", () => ({
    useNavigate: () => push,
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
        listProjects.mockResolvedValue({ items: [], next_cursor: null });
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
        render(<ProjectsOverview />);

        expect(
            await screen.findByRole("searchbox", { name: "Search projects" }),
        ).toBeVisible();
        expect(screen.getByRole("button", {
            name: "Create project +",
        })).toBeVisible();
        expect(await screen.findByText("No projects")).toBeVisible();
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
        listProjects.mockResolvedValue({ items: [createdProject], next_cursor: null });
        render(<ProjectsOverview />);
        const slot = screen.getByLabelText("Selected project actions");

        expect(slot).not.toBeNull();
        await screen.findByText(createdProject.name);
        fireEvent.click(screen.getAllByRole("checkbox")[1]);

        expect(screen.getByLabelText("Selected project actions")).toBe(slot);
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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

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
    Link: ({ to, ...props }: { to: string } & ComponentProps<"a">) => <a href={to} {...props} />,
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
            name: "New project",
        })).toBeVisible();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Boolean search help" }));
        expect(screen.getByRole("tooltip")).toHaveTextContent("AND or a space finds all terms");
        fireEvent.keyDown(screen.getByRole("button", { name: "Boolean search help" }),
            { key: "Escape" });
        expect(screen.queryByRole("tooltip")).toBeNull();
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

    it("replaces the table header with actions only while selected", async () => {
        listProjects.mockResolvedValue({ items: [createdProject], next_cursor: null });
        render(<ProjectsOverview />);

        await screen.findByText(createdProject.name);
        expect(screen.queryByText("1 selected")).toBeNull();
        expect(screen.queryByRole("button", { name: "Open in new chat" })).toBeNull();
        fireEvent.click(screen.getAllByRole("checkbox")[1]);

        expect(screen.getByText("1 selected")).toBeVisible();
        expect(screen.getByRole("button", { name: "Open in new chat" })).toBeVisible();
        fireEvent.click(screen.getByRole("button", {
            name: "More actions for selected projects",
        }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
        expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete project?");
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() =>
            expect(deleteProject).toHaveBeenCalledWith(createdProject.id),
        );
    });

    it("displays the API creation timestamp without replacing it", async () => {
        const user = userEvent.setup();
        render(<ProjectsOverview />);

        await user.click(
            await screen.findByRole("button", { name: "New project" }),
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

    it("keeps and identifies projects whose deletion fails", async () => {
        const failedProject = { ...createdProject, id: "project-failed", name: "Failed appeal" };
        listProjects.mockResolvedValue({ items: [createdProject, failedProject], next_cursor: null });
        deleteProject.mockImplementation((id) => id === failedProject.id
            ? Promise.reject(new Error("offline"))
            : Promise.resolve());
        const user = userEvent.setup();
        render(<ProjectsOverview />);

        await screen.findByText(createdProject.name);
        const checkboxes = screen.getAllByRole("checkbox");
        await user.click(checkboxes[1]);
        await user.click(checkboxes[2]);
        await user.click(screen.getByRole("button", { name: "More actions for selected projects" }));
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));

        expect(await screen.findByText("Some projects were not deleted")).toBeVisible();
        expect(screen.queryByText(createdProject.name)).toBeNull();
        expect(screen.getByText(failedProject.name)).toBeVisible();
        expect(screen.getByRole("alertdialog")).toHaveTextContent(failedProject.id);
    });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import type { Project } from "@/app/lib/api/projects";
import { ProjectsOverview } from "./ProjectsOverview";

const { createProject, deleteProject, listProjects, push, saveChat } = vi.hoisted(() => ({
    createProject: vi.fn(),
    deleteProject: vi.fn<(id: string) => Promise<void>>(),
    listProjects: vi.fn(),
    push: vi.fn(),
    saveChat: vi.fn(),
}));

const createdProject: Project = {
    id: "project-new",
    user_id: "user-1",
    is_owner: true,
    name: "New appeal",
    cm_number: null,
    practice: "Litigation",
    shared_with: [],
    created_at: "2021-07-27T18:42:00.000Z",
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

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ saveChat }),
}));

vi.mock("@/app/lib/api/projects", () => ({
  createProject,
  listProjects,
  updateProject: vi.fn(),
  deleteProject
}));

vi.mock("@/app/lib/api/documents", async (original) => ({
    ...await original<typeof import("@/app/lib/api/documents")>(),
    directoryResource: () => ({ list: async () => ({ items: [], next_cursor: null }) }),
}));

describe("ProjectsOverview", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createProject.mockResolvedValue(createdProject);
        deleteProject.mockResolvedValue(undefined);
        saveChat.mockResolvedValue("chat-1");
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
        await user.type(screen.getByRole("textbox", { name: "Project name" }), createdProject.name);
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Create project" }));

        expect(await screen.findByText("New appeal")).toBeVisible();
        expect(screen.getByText("2021", { exact: false })).toBeVisible();
        expect(push).toHaveBeenCalledWith("/projects/project-new");
    });

    it("creates the selected project's new chat before opening it", async () => {
        listProjects.mockResolvedValue({ items: [createdProject], next_cursor: null });
        const user = userEvent.setup();
        render(<ProjectsOverview />);

        await screen.findByText(createdProject.name);
        await user.click(screen.getAllByRole("checkbox")[1]);
        await user.click(screen.getByRole("button", { name: "Open in new chat" }));

        await waitFor(() => expect(push).toHaveBeenCalledWith(
            "/projects/project-new/assistant/chat/chat-1",
        ));
        expect(saveChat).toHaveBeenCalledWith("project-new");
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

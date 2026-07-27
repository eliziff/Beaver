import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/app/components/shared/types";
import { ProjectsOverview } from "./ProjectsOverview";

const { listProjects, push } = vi.hoisted(() => ({
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
    deleteProject: vi.fn(),
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
        expect(
            screen.getAllByRole("button", { name: "Create project +" }),
        ).toHaveLength(1);
        expect(await screen.findByText("No projects")).toBeVisible();
        expect(
            screen.queryByText(/Upload documents into projects/u),
        ).not.toBeInTheDocument();
        expect(container.querySelector("svg.lucide-folder")).not.toBeNull();
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

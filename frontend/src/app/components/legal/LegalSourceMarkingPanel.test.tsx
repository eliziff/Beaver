import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegalSourceMarkingPanel } from "./LegalSourceMarkingPanel";

const mocks = vi.hoisted(() => ({
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getMarking: vi.fn(),
    createLabel: vi.fn(),
    saveMark: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", () => ({
    listProjects: mocks.listProjects,
    createLegalResearchProject: mocks.createProject,
    getLegalSourceMarking: mocks.getMarking,
    createLegalResearchLabel: mocks.createLabel,
    saveLegalSourceMark: mocks.saveMark,
}));

const emptyMarking = {
    nodes: [
        {
            id: "admin",
            project_id: "general",
            kind: "label",
            name: "Administrative law",
            color: "#b91c1c",
            order: 0,
            data: {},
        },
    ],
    edges: [],
    mark: null,
};

describe("LegalSourceMarkingPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
        mocks.listProjects.mockResolvedValue({ items: [], next_cursor: null });
        mocks.getMarking.mockResolvedValue(emptyMarking);
        mocks.saveMark.mockImplementation(
            async (
                projectId: string,
                sourceId: string,
                mark: { labelIds: string[]; note: string },
            ) => ({
                source_id: sourceId,
                project_id: projectId,
                label_ids: mark.labelIds,
                note: mark.note,
            }),
        );
    });

    it("loads a saved source mark and persists label and note changes", async () => {
        const user = userEvent.setup();
        render(<LegalSourceMarkingPanel sourceId="source-1" />);

        const label = await screen.findByRole("checkbox", {
            name: "Administrative law",
        });
        await user.click(label);
        await user.type(screen.getByRole("textbox", { name: "Note" }), "Useful");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() =>
            expect(mocks.saveMark).toHaveBeenCalledWith(
                "general",
                "source-1",
                { labelIds: ["admin"], note: "Useful" },
            ),
        );
        expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    });

    it("creates and switches to a local research project", async () => {
        const user = userEvent.setup();
        mocks.createProject.mockResolvedValue({
            id: "appeal",
            name: "Appeal",
            order: 1,
        });
        render(<LegalSourceMarkingPanel sourceId="source-1" />);

        await screen.findByRole("checkbox", { name: "Administrative law" });
        await user.click(screen.getByText("New project"));
        await user.type(
            screen.getByRole("textbox", { name: "Project name" }),
            "Appeal",
        );
        await user.click(screen.getByRole("button", { name: "Create" }));

        await waitFor(() =>
            expect(mocks.createProject).toHaveBeenCalledWith("Appeal"),
        );
        await waitFor(() =>
            expect(mocks.getMarking).toHaveBeenCalledWith(
                "appeal",
                "source-1",
            ),
        );
        expect(window.localStorage.getItem("beaver:legal-research-project")).toBe(
            "appeal",
        );
    });

    it("handles clearing the final mark", async () => {
        const user = userEvent.setup();
        mocks.saveMark.mockResolvedValue(null);
        render(<LegalSourceMarkingPanel sourceId="source-1" />);

        await screen.findByRole("checkbox", { name: "Administrative law" });
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByRole("status")).toHaveTextContent("Saved");
        expect(mocks.saveMark).toHaveBeenCalledWith("general", "source-1", {
            labelIds: [],
            note: "",
        });
    });
});

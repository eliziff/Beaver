import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Document, Project } from "../shared/types";
import { NewTRModal } from "./NewTRModal";

const mocks = vi.hoisted(() => ({ getProjectDirectory: vi.fn() }));
vi.mock("@/app/lib/beaverApi", () => ({
    getProjectDirectory: mocks.getProjectDirectory,
    getLibrary: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    listProjects: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));
vi.mock("../workflows/WorkflowPickerModal", () => ({
    WorkflowPickerModal: () => null,
}));

it("creates a project review with the selected project documents", async () => {
    const document = {
        id: "document-1",
        filename: "agreement.pdf",
        status: "ready",
    } as Document;
    const project = {
        id: "project-1",
        name: "Matter",
        documents: [document],
    } as Project;
    mocks.getProjectDirectory.mockResolvedValue({
        items: [{ kind: "document", document }], next_cursor: null,
    });
    const onAdd = vi.fn();

    render(
        <NewTRModal
            open
            onClose={vi.fn()}
            onAdd={onAdd}
            projects={[project]}
        />,
    );
    fireEvent.change(screen.getByLabelText("Review name"), {
        target: { value: "Lease review" },
    });
    fireEvent.click(
        screen.getByRole("checkbox", { name: "Create under a project" }),
    );
    fireEvent.click(screen.getByRole("option", { name: /Matter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mocks.getProjectDirectory).toHaveBeenCalled());
    await screen.findByText(document.filename);
    fireEvent.click(screen.getByRole("checkbox", {
        name: `Select ${document.filename}`,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onAdd).toHaveBeenCalledWith(
        "Lease review",
        project.id,
        [document.id],
        undefined,
    );
});

it("uses a default name when the review name is blank", () => {
    const onAdd = vi.fn();
    render(
        <NewTRModal
            open
            onClose={vi.fn()}
            onAdd={onAdd}
        />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onAdd).toHaveBeenCalledWith(
        "Untitled review",
        undefined,
        undefined,
        undefined,
    );
});

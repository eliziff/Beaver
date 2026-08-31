import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Document, Project, Workflow } from "../shared/types";
import { NewTRModal } from "./NewTRModal";

const mocks = vi.hoisted(() => ({
    listDirectory: vi.fn(),
    uploadDocument: vi.fn(),
    getWorkflow: vi.fn(),
    listWorkflows: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/app/lib/beaverApi", () => ({
    getWorkflow: mocks.getWorkflow,
    directoryResource: () => ({
        list: mocks.listDirectory,
        uploadDocument: mocks.uploadDocument,
    }),
    listWorkflows: mocks.listWorkflows,
    listProjects: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    uploadStandaloneDocument: vi.fn(),
    uploadDocumentsSettled: vi.fn(),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: null }),
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
    mocks.listDirectory.mockResolvedValue({
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
    fireEvent.click(screen.getByRole("checkbox", { name: "Create under a project" }));
    fireEvent.click(screen.getByRole("button", { name: "Matter" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalled());
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
        undefined,
    );
});

it("uses a default name when the review name is blank", async () => {
    const onAdd = vi.fn();
    render(
        <NewTRModal
            open
            onClose={vi.fn()}
            onAdd={onAdd}
        />,
    );

    await waitFor(() => expect(screen.getByLabelText("Workflow template"))
        .not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onAdd).toHaveBeenCalledWith(
        "Untitled review",
        undefined,
        undefined,
        undefined,
        undefined,
    );
});

it("passes the selected workflow through to review creation", async () => {
    const workflow = {
        id: "contract-review", is_system: false,
        metadata: { title: "Contract review", category: "Review",
            audiences: ["general"], jurisdictions: ["General"], language: "English" },
        launcher: { kind: "instructions", variants: [{
            id: "contract-table", label: "Review contracts", result: "Table",
            execution: "tabular", skill_md: null, columns_config: [],
        }] },
    } as Workflow;
    mocks.listWorkflows.mockResolvedValueOnce([workflow]);
    const onAdd = vi.fn();
    render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} />);

    fireEvent.change(await screen.findByLabelText("Workflow template"), {
        target: { value: "contract-table" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(
        "Untitled review", undefined, undefined, [], workflow.id,
    ));
});

it("keeps entered details when creation fails", async () => {
    mocks.listWorkflows.mockResolvedValueOnce([]);
    const onAdd = vi.fn().mockRejectedValue(new Error("offline"));
    render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} />);
    fireEvent.change(screen.getByLabelText("Review name"), {
        target: { value: "Lease review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be created/i);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Review name")).toHaveValue("Lease review");
});

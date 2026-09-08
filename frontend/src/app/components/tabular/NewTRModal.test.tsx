import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Document } from "@/app/lib/api/documents";
import { listProjects, type Project } from "@/app/lib/api/projects";
import type { Workflow } from "@/app/lib/api/workflows";
import { NewTRModal } from "./NewTRModal";

const mocks = vi.hoisted(() => ({
    listDirectory: vi.fn(),
    uploadDocument: vi.fn(),
    getWorkflow: vi.fn(),
    listWorkflows: vi.fn().mockResolvedValue([]),
    design: vi.fn(),
    getResearchFile: vi.fn(),
    openWorkspaceTable: vi.fn(),
    previewWorkspaceTable: vi.fn(),
}));
vi.mock("@/app/lib/api/tabular", async (original) => ({
  ...await original<typeof import("@/app/lib/api/tabular")>(), designTabularReview: mocks.design,
}));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  getResearchFile: mocks.getResearchFile, openWorkspaceTable: mocks.openWorkspaceTable, previewWorkspaceTable: mocks.previewWorkspaceTable,
}));
vi.mock("@/app/lib/api/workflows", () => ({
  getWorkflow: mocks.getWorkflow,
  listWorkflows: mocks.listWorkflows
}));
vi.mock("@/app/lib/api/documents", () => ({
  directoryResource: () => ({
        list: mocks.listDirectory,
        uploadDocument: mocks.uploadDocument,
    }),
  uploadStandaloneDocument: vi.fn(),
  uploadDocumentsSettled: vi.fn()
}));
vi.mock("@/app/lib/api/projects", () => ({
  listProjects: vi.fn().mockResolvedValue({ items: [], next_cursor: null })
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
    vi.mocked(listProjects).mockResolvedValueOnce({ items: [project], next_cursor: null });
    const onAdd = vi.fn();

    render(
        <NewTRModal
            open
            onClose={vi.fn()}
            onAdd={onAdd} onOpen={vi.fn()}
            projects={[project]}
        />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Set columns manually" }));
    fireEvent.change(screen.getByLabelText("Review name"), {
        target: { value: "Lease review" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    fireEvent.click(await screen.findByRole("button", { name: "Matter" }));
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
            onAdd={onAdd} onOpen={vi.fn()}
        />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Set columns manually" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onAdd).toHaveBeenCalledWith(
        "Untitled review",
        undefined,
        undefined,
        undefined,
        undefined,
    );
});

it("offers solicitor review workflows immediately and passes their configuration to creation", async () => {
    const workflow = {
        id: "contract-review", is_system: false,
        metadata: { title: "Contract review", category: "Review",
            audiences: ["solicitor"], jurisdictions: ["General"], language: "English" },
        launcher: { kind: "instructions", variants: [{
            id: "contract-table", label: "Review contracts", result: "Table",
            execution: "tabular", skill_md: null, columns_config: [{ index: 0, name: "Parties", prompt: "Identify the parties." }],
        }] },
    } as Workflow;
    mocks.listWorkflows.mockResolvedValueOnce([workflow]);
    const onAdd = vi.fn();
    render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} onOpen={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Start Tabular Review: Contract review" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(
        "Untitled review", undefined, undefined,
        [{ index: 0, name: "Parties", prompt: "Identify the parties." }], workflow.id,
    ));
});

it("creates a customized review using the shared column editor", async () => {
    const onAdd = vi.fn();
    render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Set columns manually" }));
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    fireEvent.change(screen.getByLabelText("Column title"), { target: { value: "Clause" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Extract the clause." } });
    await screen.findByRole("button", { name: "Clause" });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("Untitled review", undefined,
        undefined, [expect.objectContaining({ index: 0, name: "Clause", prompt: "Extract the clause." })], undefined));
});

it("keeps entered details when creation fails", async () => {
    mocks.listWorkflows.mockResolvedValueOnce([]);
    const onAdd = vi.fn().mockRejectedValue(new Error("offline"));
    render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Set columns manually" }));
    fireEvent.change(screen.getByLabelText("Review name"), {
        target: { value: "Lease review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be created/i);
    expect(screen.getByLabelText("Review name")).toHaveValue("Lease review");
});

it("creates from an exact research passage scope while retaining custom extraction questions", async () => {
    const onAdd = vi.fn();
    const research = { researchFileId: "research-1", selection: {
        sourceIds: ["source-1"], evidenceIds: ["original-passage"], target: "passages" as const,
    } };
    render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} onOpen={vi.fn()} research={research} />);
    fireEvent.click(screen.getByRole("button", { name: "Create custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Set columns manually" }));
    expect(screen.queryByRole("region", { name: "Documents" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    fireEvent.change(screen.getByLabelText("Column title"), { target: { value: "Hearing" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Explain whether an oral hearing was required." } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("Untitled review", undefined, undefined,
        [expect.objectContaining({ index: 0, name: "Hearing", prompt: "Explain whether an oral hearing was required." })],
        undefined, research));
});



it("creates a review from a library folder without a project", async () => {
    const document = { id: "folder-doc", filename: "terms.pdf", project_id: null, folder_id: "folder-1" } as Document;
    mocks.listDirectory.mockImplementation(({ parent_id }: { parent_id?: string }) => Promise.resolve({
        items: parent_id === "folder-1" ? [{ kind: "document", document }]
            : [{ kind: "folder", folder: { id: "folder-1", name: "Contracts", parent_folder_id: null } }],
        next_cursor: null,
    }));
    const onAdd = vi.fn();
    render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Set columns manually" }));
    fireEvent.click(await screen.findByRole("button", { name: "Contracts" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select terms.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("Untitled review", undefined, [document.id], undefined, undefined));
});

it("keeps incomplete columns editable in the same dialog", async () => {
    const onAdd = vi.fn();
    render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Set columns manually" }));
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    fireEvent.change(screen.getByLabelText("Column title"), { target: { value: "Custom field" } });
    fireEvent.click(screen.getByRole("button", { name: "Custom field" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByLabelText("Prompt")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Extract this field." } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("Untitled review", undefined, undefined,
        [expect.objectContaining({ name: "Custom field", prompt: "Extract this field." })], undefined));
});

it("preserves custom columns when returning from the workflow choices", async () => {
    const onAdd = vi.fn();
    render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Set columns manually" }));
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    fireEvent.change(screen.getByLabelText("Column title"), { target: { value: "My column" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "My instructions" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Set columns manually" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("Untitled review", undefined, undefined,
        [expect.objectContaining({ name: "My column", prompt: "My instructions" })], undefined));
});

it("fills the form from a proposed design and revises it", async () => {
    const first = { index: 0, name: "Deadline", prompt: "Find the delivery deadline", format: "text" as const };
    mocks.design.mockResolvedValueOnce({ title: "Delivery review", columns_config: [first] })
        .mockResolvedValueOnce({ title: "Delivery review", columns_config: [first,
            { index: 1, name: "Penalty", prompt: "Find the penalty", format: "text" as const }] });
    const onAdd = vi.fn();
    render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat assist" }));
    fireEvent.change(screen.getByLabelText("Describe the review"), { target: { value: "Compare delivery terms" } });
    fireEvent.click(screen.getByRole("button", { name: "Propose design" }));

    await waitFor(() => expect(screen.getByLabelText("Review name")).toHaveValue("Delivery review"));
    expect(screen.getByRole("button", { name: "Deadline" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Describe the review"), { target: { value: "add a penalty column" } });
    fireEvent.click(screen.getByRole("button", { name: "Propose design" }));
    expect(await screen.findByRole("button", { name: "Penalty" })).toBeVisible();
    expect(mocks.design).toHaveBeenLastCalledWith({ request: "add a penalty column",
        title: "Delivery review", current: [first] });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("Delivery review", undefined, undefined,
        [expect.objectContaining({ name: "Deadline" }), expect.objectContaining({ name: "Penalty" })], undefined));
});

it("imports a research set and opens the created review", async () => {
    const set = { id: "set-1", filename: "Appeal.research.md", file_type: "md", project_id: null } as Document;
    mocks.listDirectory.mockResolvedValue({ items: [{ kind: "document", document: set }], next_cursor: null });
    mocks.getResearchFile.mockResolvedValue({ document: set, versionId: "v1", workingRevision: 0, state: {
        labels: { pen: { id: "pen", name: "Key", parentId: null, color: "#eab308", order: 0, scope: "highlight" } },
        sources: {}, queries: null, note: "" } });
    const preview = { fingerprint: "a".repeat(64), design: { title: "Appeal", columns: [{ index: 0, name: "Key", prompt: "Saved key passages" }],
        cells: [{ rowId: "passage", columnIndex: 0, itemIds: ["item"] }] }, rows: [{ id: "passage", sourceId: "source", title: "Case" }],
        stats: [{ index: 0, reused: 1, kinds: ["passages"], evidence: 1 }], samples: [{ rowId: "passage", columnIndex: 0, text: "Saved passage", kinds: ["passages"] }] };
    mocks.previewWorkspaceTable.mockResolvedValue(preview);
    mocks.openWorkspaceTable.mockResolvedValue({ id: "review-9", project_id: null });
    const onOpen = vi.fn();
    render(<NewTRModal open onClose={vi.fn()} onAdd={vi.fn()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Create custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Import a Research set" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Select Appeal" }));
    const create = () => screen.getByRole("button", { name: "Create table" });
    await waitFor(() => expect(create()).toBeEnabled());
    fireEvent.click(create());
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/tabular-reviews/review-9"));
    expect(mocks.openWorkspaceTable).toHaveBeenCalledWith("set-1", { design: preview.design, fingerprint: preview.fingerprint });
});

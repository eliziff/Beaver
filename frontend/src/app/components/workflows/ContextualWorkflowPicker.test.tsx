import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Workflow } from "@/app/lib/api/workflows";
import {
    ContextualWorkflowLauncher,
    ContextualWorkflowPicker,
    type WorkflowDocument,
} from "./ContextualWorkflowPicker";

const mocks = vi.hoisted(() => ({
    createAuthorities: vi.fn(),
    createTabularReview: vi.fn(),
    saveChat: vi.fn(),
    stageNewChatDocuments: vi.fn(),
    stagePendingChatMessage: vi.fn(),
    inspect: vi.fn(),
    navigate: vi.fn(),
    list: vi.fn(),
}));

vi.mock("../assistant/assistantLaunch", () => ({ stageNewChatDocuments: mocks.stageNewChatDocuments }));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({ useChatHistoryContext: () => mocks }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/app/lib/api/documents", () => ({
  directoryResource: () => ({ list: mocks.list }),
  inspectDocxWorkflowCapabilities: mocks.inspect
}));
vi.mock("@/app/lib/api/authorities", () => ({
  createAuthorities: mocks.createAuthorities
}));
vi.mock("@/app/lib/api/tabular", () => ({
  createTabularReview: mocks.createTabularReview
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useUserProfile: () => ({ profile: null }) }));
vi.mock("@/app/lib/api/workflows", () => ({ listWorkflows: async () => [drafting, authorities, courtRecords, supras] }));

const drafting: Workflow = {
    id: "drafting", user_id: null, is_system: true, created_at: "2026-08-31T00:00:00Z",
    metadata: { title: "Drafting", description: "Draft and review.",
        category: "Drafting and document preparation", audiences: ["general"],
        contributors: [], language: "English", version: "1", jurisdictions: ["General"] },
    launcher: { kind: "instructions", variants: [
        { id: "proofread", label: "Proofread", result: null, execution: "assistant",
            skill_md: null, columns_config: null },
        { id: "issues", label: "Create issues table", result: "Table", execution: "tabular",
            skill_md: null, columns_config: [{ index: 0, name: "Issue", prompt: "Find issues", format: "text" }] },
    ] },
};
const authorities: Workflow = { ...drafting, id: "authorities",
    metadata: { ...drafting.metadata, title: "Authorities" },
    launcher: { kind: "authorities" } };
const courtRecords: Workflow = { ...drafting, id: "court-records",
    metadata: { ...drafting.metadata, title: "Court Records" },
    launcher: { kind: "court_records" } };
const supras: Workflow = { ...drafting, id: "fix-supras", metadata: { ...drafting.metadata, title: "Fix supras" }, launcher: { kind: "fix_supras" } };
const document = (id: string, filename = `${id}.docx`): WorkflowDocument => ({
    id, filename, file_type: filename.split(".").pop(), project_id: "project-1",
});

beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.inspect.mockResolvedValue({ supra_references: false });
    mocks.saveChat.mockResolvedValue("new-chat");
    mocks.list.mockResolvedValue({ items: [], next_cursor: null });
});

it("binds a sole source to the latest Authorities draft", async () => {
    mocks.createAuthorities.mockResolvedValue({ id: "authorities-1" });
    render(<ContextualWorkflowPicker documents={[document("factum")]}
        onAssistantSelect={vi.fn()} />);

    expect(screen.getByText("Using factum.docx")).toBeVisible();
    await userEvent.click(await screen.findByRole("button", { name: "Open: Authorities" }));

    expect(mocks.createAuthorities).toHaveBeenCalledWith({
        source: { kind: "document", documentId: "factum", version: "latest" },
        projectId: "project-1",
    });
    expect(mocks.navigate).toHaveBeenCalledWith(
        "/table-of-authorities?draft=authorities-1&project=project-1");
});

it("hands selected files to Court Records for filing selection", async () => {
    const documents = [document("notice"), document("affidavit", "affidavit.pdf")];
    render(<ContextualWorkflowPicker documents={documents}
        onAssistantSelect={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Open: Court Records" }));

    expect(mocks.navigate).toHaveBeenCalledWith(
        "/court-records?project=project-1", { state: { documents: [
            { id: "notice", filename: "notice.docx" },
            { id: "affidavit", filename: "affidavit.pdf" },
        ] } });
});

it("uses every selected document for tables and assistant work", async () => {
    const documents = [document("one"), document("two")];
    const onAssistantSelect = vi.fn();
    mocks.createTabularReview.mockResolvedValue({ id: "review-1" });
    render(<ContextualWorkflowPicker documents={documents}
        onAssistantSelect={onAssistantSelect} />);

    await userEvent.click(await screen.findByRole("button", { name: "Details for Drafting" }));
    await userEvent.click(screen.getByRole("button", { name: "Open chat: Proofread" }));
    expect(onAssistantSelect).toHaveBeenCalledWith(expect.objectContaining({
        variant: expect.objectContaining({ id: "proofread" }),
    }), documents);

    await userEvent.click(screen.getByRole("button", { name: "Start Tabular Review: Create issues table" }));
    expect(mocks.createTabularReview).toHaveBeenCalledWith({
        title: "Create issues table", document_ids: ["one", "two"],
        columns_config: [{ index: 0, name: "Issue", prompt: "Find issues", format: "text" }],
        workflow_id: "drafting", project_id: "project-1",
    });
    expect(mocks.navigate).toHaveBeenCalledWith(
        "/projects/project-1/tabular-reviews/review-1",
    );
});

it("opens the selected Word document in a new chat with a tracked-change request", async () => {
    render(<ContextualWorkflowLauncher documents={[document("lease", "Lease.docx")]} />);
    await userEvent.click(screen.getByRole("button", { name: "Workflows" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open: Fix supras" }));
    await waitFor(() => expect(mocks.stagePendingChatMessage).toHaveBeenCalledWith("new-chat",
        expect.objectContaining({ editMode: "manual", files: [{ document_id: "lease", filename: "Lease.docx" }] })));
    expect(mocks.stageNewChatDocuments).toHaveBeenCalledWith([document("lease", "Lease.docx")]);
    expect(mocks.navigate).toHaveBeenCalledWith("/projects/project-1/assistant/chat/new-chat");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workflows" })).toBeNull());
});

it("runs in the originating chat without creating another chat", async () => {
    const onRun = vi.fn();
    const source = document("lease");
    render(<ContextualWorkflowPicker documents={[source]} onRun={onRun} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open: Fix supras" }));
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({
        editMode: "manual", files: [{ document_id: source.id, filename: source.filename }],
    }), source);
    expect(mocks.saveChat).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
});

it("keeps Fix supras discoverable without attachments and selects a Word document at launch", async () => {
    mocks.list.mockResolvedValue({ items: [{ kind: "document", document: document("selected") }] });
    render(<ContextualWorkflowPicker />);
    await userEvent.click(await screen.findByRole("button", { name: "Open: Fix supras" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Select selected.docx" }));
    await userEvent.click(screen.getByRole("button", { name: "Fix supras" }));
    await waitFor(() => expect(mocks.stagePendingChatMessage).toHaveBeenCalledWith("new-chat",
        expect.objectContaining({ files: [{ document_id: "selected", filename: "selected.docx" }] })));
});

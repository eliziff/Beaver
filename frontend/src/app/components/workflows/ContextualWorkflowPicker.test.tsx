import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Workflow, WorkflowVariant } from "../shared/types";
import {
    ContextualWorkflowLauncher,
    ContextualWorkflowPicker,
    type WorkflowDocument,
} from "./ContextualWorkflowPicker";

const mocks = vi.hoisted(() => ({
    createAuthorities: vi.fn(),
    createWorkProduct: vi.fn(),
    createTabularReview: vi.fn(),
    fixSupras: vi.fn(),
    inspect: vi.fn(),
    navigate: vi.fn(),
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/app/lib/beaverApi", () => ({
    createAuthorities: mocks.createAuthorities,
    createWorkProduct: mocks.createWorkProduct,
    createTabularReview: mocks.createTabularReview,
    fixLibraryDocxSupras: mocks.fixSupras,
    inspectDocxWorkflowCapabilities: mocks.inspect,
}));
vi.mock("./WorkflowPickerModal", () => ({
    useWorkflowPickerState: () => ({ workflows: [drafting, authorities, courtRecords], search: "",
        setSearch: vi.fn(), audience: "general", setAudience: vi.fn(), loading: false,
        loadError: false, retryLoad: vi.fn() }),
}));
vi.mock("./WorkflowPickerContent", () => ({
    WorkflowPickerContent: ({ workflows, onSelect, contextLabel, workflowAction,
        disabledItem }: {
        workflows: Workflow[];
        onSelect: (workflow: Workflow, variant?: WorkflowVariant) => void;
        contextLabel?: string;
        workflowAction?: (workflow: Workflow) => React.ReactNode;
        disabledItem?: (workflow: Workflow, variant?: WorkflowVariant) => boolean;
    }) => <>
        <output aria-label="Workflow context">{contextLabel}</output>
        {workflows.map((workflow) => <div key={workflow.id}>
            <span>{workflow.metadata.title}</span>
            {workflow.launcher.kind === "instructions" && workflow.launcher.variants.map(
                (variant) => <button key={variant.id} type="button"
                    disabled={disabledItem?.(workflow, variant)}
                    onClick={() => onSelect(workflow, variant)}>{variant.label}</button>)}
            {workflow.launcher.kind !== "instructions" && <button type="button"
                onClick={() => onSelect(workflow)}>Open {workflow.metadata.title}</button>}
            {workflowAction?.(workflow)}
        </div>)}
    </>,
}));

const drafting: Workflow = {
    id: "drafting", user_id: null, is_system: true, created_at: "2026-08-31T00:00:00Z",
    metadata: { title: "Drafting", description: "Draft and review.",
        category: "Drafting and document preparation", audiences: ["general"],
        contributors: [], language: "English", version: "1", jurisdictions: ["General"] },
    launcher: { kind: "instructions", variants: [
        { id: "proofread", label: "Proofread", result: null, execution: "assistant",
            skill_md: null, columns_config: null },
        { id: "issues", label: "Create issues table", result: "Table", execution: "tabular",
            skill_md: null, columns_config: [{ name: "Issue", type: "text" }] },
    ] },
};
const authorities: Workflow = { ...drafting, id: "authorities",
    metadata: { ...drafting.metadata, title: "Authorities" },
    launcher: { kind: "authorities" } };
const courtRecords: Workflow = { ...drafting, id: "court-records",
    metadata: { ...drafting.metadata, title: "Court Records" },
    launcher: { kind: "court_records" } };
const document = (id: string, filename = `${id}.docx`): WorkflowDocument => ({
    id, filename, file_type: filename.split(".").pop(), project_id: "project-1",
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspect.mockResolvedValue({ supra_references: false });
});

it("binds a sole source to the latest Authorities draft", async () => {
    mocks.createAuthorities.mockResolvedValue({ id: "authorities-1" });
    render(<ContextualWorkflowPicker documents={[document("factum")]}
        onAssistantSelect={vi.fn()} />);

    expect(screen.getByRole("status", { name: "Workflow context" }))
        .toHaveTextContent("factum.docx");
    await userEvent.click(screen.getByRole("button", { name: "Open Authorities" }));

    expect(mocks.createAuthorities).toHaveBeenCalledWith({
        source: { kind: "document", documentId: "factum", version: "latest" },
        projectId: "project-1",
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/table-of-authorities?draft=authorities-1");
});

it("persists selected files in a new Court Records draft before navigation", async () => {
    mocks.createWorkProduct.mockResolvedValue({ id: "record-1" });
    render(<ContextualWorkflowPicker documents={[document("notice"), document("affidavit", "affidavit.pdf")]}
        onAssistantSelect={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Open Court Records" }));

    expect(mocks.createWorkProduct).toHaveBeenCalledWith({
        kind: "court-record",
        title: "Untitled court record",
        projectId: "project-1",
        state: {
            profileId: "",
            cover: {},
            entries: [
                { id: "notice", kindId: "unassigned", title: "notice",
                    lastSeen: { name: "notice.docx", size: 0, modified: 0 } },
                { id: "affidavit", kindId: "unassigned", title: "affidavit",
                    lastSeen: { name: "affidavit.pdf", size: 0, modified: 0 } },
            ],
            bindings: {
                notice: { kind: "document", documentId: "notice", version: "latest" },
                affidavit: { kind: "document", documentId: "affidavit", version: "latest" },
            },
        },
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/court-records?draft=record-1");
});

it("uses every selected document for tables and assistant work", async () => {
    const documents = [document("one"), document("two")];
    const onAssistantSelect = vi.fn();
    mocks.createTabularReview.mockResolvedValue({ id: "review-1" });
    render(<ContextualWorkflowPicker documents={documents}
        onAssistantSelect={onAssistantSelect} />);

    await userEvent.click(screen.getByRole("button", { name: "Proofread" }));
    expect(onAssistantSelect).toHaveBeenCalledWith(expect.objectContaining({
        variant: expect.objectContaining({ id: "proofread" }),
    }), documents);

    await userEvent.click(screen.getByRole("button", { name: "Create issues table" }));
    expect(mocks.createTabularReview).toHaveBeenCalledWith({
        title: "Create issues table", document_ids: ["one", "two"],
        columns_config: [{ name: "Issue", type: "text" }],
        workflow_id: "drafting", project_id: "project-1",
    });
    expect(mocks.navigate).toHaveBeenCalledWith(
        "/projects/project-1/tabular-reviews/review-1",
    );
});

it("opens one modal directly and keeps the applicable DOCX operation", async () => {
    const onDocumentChanged = vi.fn();
    mocks.inspect.mockResolvedValue({ supra_references: true });
    mocks.fixSupras.mockResolvedValue({ ok: true, document_id: "lease",
        version_id: "version-2", filename: "Lease - supras fixed.docx",
        detected: 3, converted: 2, already_linked: 1, review_required: 0 });
    render(<ContextualWorkflowLauncher documents={[document("lease", "Lease.docx")]}
        onDocumentChanged={onDocumentChanged} />);

    await userEvent.click(screen.getByRole("button", { name: "Workflows" }));
    expect(screen.getByRole("dialog", { name: "Workflows" })).toBeVisible();
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Fix supras" }));

    await waitFor(() => expect(mocks.fixSupras).toHaveBeenCalledWith("lease"));
    expect(onDocumentChanged).toHaveBeenCalledWith(
        expect.objectContaining({ version_id: "version-2" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workflows" })).toBeNull());
});

it("hands an in-app document to an existing workflow dock", async () => {
    const documents = [document("lease")];
    const onOpen = vi.fn();
    render(<ContextualWorkflowLauncher documents={documents} onOpen={onOpen} />);

    await userEvent.click(screen.getByRole("button", { name: "Workflows" }));

    expect(onOpen).toHaveBeenCalledWith(documents);
    expect(screen.queryByRole("dialog")).toBeNull();
});

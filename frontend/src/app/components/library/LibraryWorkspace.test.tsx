import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { Document } from "@/app/lib/api/documents";
import type { WorkflowSelection } from "../workflows/workflowRoutes";
import { assistantWorkflowLaunch } from "../workflows/workflowRoutes";
import { LibraryCollectionPage } from "./LibraryWorkspace";

const mocks = vi.hoisted(() => ({ stage: vi.fn() }));
const source = { id: "brief", filename: "Brief.docx" } as Document;
const selection = {
    workflow: { id: "drafting", metadata: { title: "Drafting" } },
    variant: { id: "proofread", execution: "assistant" },
} as WorkflowSelection;

vi.mock("../assistant/assistantLaunch", () => ({
    stageNewChatDocuments: mocks.stage,
}));
vi.mock("../documents/DocTable", () => ({
    DocTable: ({ onAssistantWorkflowSelect, scopeKey }: {
        scopeKey: string;
        onAssistantWorkflowSelect: (
            selection: WorkflowSelection, documents: Document[],
        ) => void;
    }) => <><input aria-label={`${scopeKey} state`} /><button type="button"
            onClick={() => onAssistantWorkflowSelect(selection, [source])}>
            Proofread selected
        </button></>,
}));
vi.mock("../../hooks/usePagedDirectory", () => ({
    usePagedDirectory: () => ({
        documents: [], folders: [], loading: false, reload: vi.fn(),
        replaceDocumentParseStates: vi.fn(), hasMoreParents: new Set(),
        loadingParents: new Set(), ensureParent: vi.fn(), loadMore: vi.fn(),
    }),
}));
vi.mock("@/app/lib/api/documents", () => ({
  directoryResource: () => ({ list: vi.fn() }),
  getDocumentParseStates: vi.fn(),
  retryLibraryPdfParse: vi.fn()
}));

function Location() {
    const location = useLocation();
    return <output aria-label="Location">{JSON.stringify({
        pathname: location.pathname, state: location.state,
    })}</output>;
}

it("hands selected Library documents to a new assistant workflow", async () => {
    render(<MemoryRouter initialEntries={["/library"]}>
        <LibraryCollectionPage kind="files" />
        <Location />
    </MemoryRouter>);

    await userEvent.click(screen.getByRole("button", { name: "Proofread selected" }));

    expect(mocks.stage).toHaveBeenCalledWith([source]);
    expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent(
        JSON.stringify({ pathname: "/assistant", state: assistantWorkflowLaunch(selection) }),
    );
});

it("keeps each visited Library section mounted", async () => {
    const view = (kind: "files" | "templates") => <MemoryRouter>
        <LibraryCollectionPage kind={kind} />
    </MemoryRouter>;
    const { rerender } = render(view("files"));
    await userEvent.type(screen.getByLabelText("files state"), "kept");

    rerender(view("templates"));
    expect(screen.getByLabelText("templates state")).toBeVisible();
    rerender(view("files"));
    expect(screen.getByLabelText("files state")).toHaveValue("kept");
});

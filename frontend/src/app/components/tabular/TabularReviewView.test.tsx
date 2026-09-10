import {
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Document } from "@/app/lib/api/documents";
import type { TabularCell, TabularReview } from "@/app/lib/api/tabular";
import { TRView } from "./TabularReviewView";

const mocks = vi.hoisted(() => ({
    getTabularReview: vi.fn(),
    getProject: vi.fn(),
    listProjects: vi.fn(),
    startGeneration: vi.fn(),
    regenerateCell: vi.fn(),
    uploadDocument: vi.fn(),
    updateReview: vi.fn(),
    previewWorkspaceLabels: vi.fn(),
    applyWorkspaceLabels: vi.fn(),
    getResearchFile: vi.fn(),
    ensureWorkspace: vi.fn(),
}));
function fixture(status: TabularCell["status"]) {
    const document = { id: "document-1", filename: "lease.pdf" } as Document;
    const cell = {
        id: "cell-1",
        document_id: document.id,
        column_index: 0,
        content: status === "done" ? { summary: "Two years", claims: [], evidence: [],
            outcome: "answered", coverage: "complete" } : null,
        status,
    } as TabularCell;
    return {
        cell,
        document,
        data: {
            review: {
                id: "review-1",
                title: "Lease review",
                columns_config: [
                    { index: 0, name: "Term", prompt: "Find term" },
                ],
            } as TabularReview,
            cells: [cell],
            documents: [document],
        },
    };
}

vi.mock("react-router-dom", () => ({
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: "/tabular-reviews/review-1", search: "", state: null }),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock("@/app/lib/api/tabular", () => ({
  clearTabularCells: vi.fn(),
  deleteTabularReview: vi.fn(),
  getTabularReview: mocks.getTabularReview,
  getTabularReviewPeople: vi.fn(),
  regenerateTabularCell: mocks.regenerateCell,
  startTabularGeneration: mocks.startGeneration,
  stopTabularGeneration: vi.fn(),
  updateTabularReview: mocks.updateReview,
}));
vi.mock("@/app/lib/api/researchFiles", () => ({
  getResearchFile: mocks.getResearchFile,
  previewWorkspaceLabels: mocks.previewWorkspaceLabels,
  applyWorkspaceLabels: mocks.applyWorkspaceLabels,
  ensureSourcesWorkspace: mocks.ensureWorkspace,
  actOnResearchFile: vi.fn(),
  runResearchFileQuery: vi.fn(),
  bindWorkspaceView: vi.fn(),
  openWorkspaceTable: vi.fn(),
  getWorkspaceViews: vi.fn(),
  getResearchItems: vi.fn().mockResolvedValue({ items: [], next_cursor: null, total: 0 }),
  getWorkspaceFindings: vi.fn().mockResolvedValue({ items: [], total: 0, next_offset: null })
}));
vi.mock("../legal/ResearchWorkspaceHost", () => ({ ResearchWorkspaceHost: () => <div>Sources workspace</div> }));
vi.mock("@/app/lib/api/documents", () => ({
  directoryResource: () => ({ uploadDocument: mocks.uploadDocument }),
  uploadStandaloneDocument: vi.fn()
}));
vi.mock("@/app/lib/api/projects", () => ({
  getProject: mocks.getProject,
  listProjects: mocks.listProjects
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: null }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: null }),
}));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("@/app/hooks/useSelectedModel", () => ({
    useSelectedModel: () => ["gpt-5"],
    useSelectedReasoningEffort: () => ["medium"],
}));
vi.mock("./TRChatPanel", async () => {
    const { useSourcesWorkspace } = await import("../legal/SourcesWorkspace");
    return { TRChatPanel: ({ workspaceReady, scopeLabel, onClearScope }: { workspaceReady: boolean; scopeLabel?: string; onClearScope?: () => void }) => {
        const workspace = useSourcesWorkspace();
        return <div data-testid="discussion" data-ready={String(workspaceReady)} data-selection={JSON.stringify(workspace.selection)}>
            {scopeLabel}<button onClick={onClearScope}>Discuss all columns</button></div>;
    } };
});
vi.mock("./AddColumnModal", () => ({ AddColumnModal: () => null }));
vi.mock("./TabularReviewDetailsModal", () => ({
    TabularReviewDetailsModal: () => null,
}));
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: ({ open, sources, onAddSources }: {
        open: boolean; sources?: { id: string; title: string }[];
        onAddSources?: (ids: string[]) => Promise<void>;
    }) => open ? <>{sources?.map(({ id, title }) => <button key={id}
        onClick={() => void onAddSources?.([id])}>{`Add ${title}`}</button>)}</> : null,
}));
vi.mock("../modals/PeopleModal", () => ({ PeopleModal: () => null }));
vi.mock("../popups/OwnerOnlyPopup", () => ({ OwnerOnlyPopup: () => null }));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));
vi.mock("../popups/ConfirmPopup", () => ({ ConfirmPopup: () => null }));
vi.mock("../workflows/WorkflowPickerModal", () => ({
    WorkflowPickerModal: () => null,
}));

it("projects queued agents into the table", async () => {
    mocks.listProjects.mockResolvedValue({ items: [], next_cursor: null });
    mocks.getTabularReview.mockResolvedValue(fixture("pending").data);
    mocks.startGeneration.mockImplementation(async () => {
        const running = fixture("generating").data;
        mocks.getTabularReview.mockResolvedValue({ ...running, review: { ...running.review, is_running: true } });
        return { job_ids: ["job-1"], queued: 1 };
    });
    render(<TRView reviewId="review-1" />);

    await screen.findByRole("button", { name: "Term actions" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByRole("button", { name: "Stop" });
    fireEvent.click(screen.getByRole("button", { name: "Open Term result" }));
    expect(screen.getByRole("dialog", { name: "Term result" })).toHaveTextContent("Running…");
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
    expect(mocks.startGeneration).toHaveBeenCalledWith("review-1", {
        model: "gpt-5", reasoningEffort: "medium",
    });
    expect(screen.getByRole("progressbar", { name: "Run progress" })).toHaveAttribute("aria-valuemax", "1");
});

it("shows row actions only while rows are selected", async () => {
    mocks.getTabularReview.mockResolvedValue(fixture("done").data);
    render(<TRView reviewId="review-1" />);
    await screen.findByRole("button", { name: "Term actions" });
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select lease.pdf" }));
    expect(screen.getByText("1 selected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear results" })).toBeEnabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select lease.pdf" }));
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
});

it("reruns a column one row at a time as the review goes idle", async () => {
    const first = fixture("done");
    const second = { id: "document-2", filename: "deed.pdf" } as Document;
    const data = { ...first.data, documents: [first.document, second],
        cells: [first.cell, { ...first.cell, id: "cell-2", document_id: second.id }] };
    mocks.getTabularReview.mockResolvedValue(data);
    mocks.regenerateCell.mockResolvedValue({ job_id: "job-1", queued: true });
    render(<TRView reviewId="review-1" />);
    await screen.findByRole("button", { name: "Term actions" });

    fireEvent.click(screen.getByRole("button", { name: "Term actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rerun column" }));
    await waitFor(() => expect(mocks.regenerateCell).toHaveBeenCalledTimes(1));
    expect(mocks.regenerateCell).toHaveBeenCalledWith("review-1", first.document.id, 0, { model: "gpt-5", reasoningEffort: "medium" });
    expect(screen.getByRole("progressbar", { name: "Run progress" })).toHaveAttribute("aria-valuemax", "2");
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();

    mocks.getTabularReview.mockResolvedValue({ ...data, review: { ...data.review, is_running: false } });
    await waitFor(() => expect(mocks.regenerateCell).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    expect(mocks.regenerateCell).toHaveBeenLastCalledWith("review-1", second.id, 0, { model: "gpt-5", reasoningEffort: "medium" });
});

it("shows review results without waiting for project metadata", async () => {
    mocks.getProject.mockReturnValue(new Promise(() => {}));
    mocks.getTabularReview.mockResolvedValue(fixture("done").data);
    render(<TRView reviewId="review-1" projectId="project-1" />);
    await screen.findByRole("button", { name: "Term actions" });
    expect(screen.getByText("Two years")).toBeVisible();
});

const workspaceFile = (sources: Record<string, unknown>) => ({
    document: { id: "workspace-1" }, versionId: "v1", workingRevision: 0,
    state: { labels: {}, sources, queries: null, note: "" },
});
const scoped = (columns: { index: number; name: string; prompt: string; format?: string }[]) => {
    const first = fixture("done");
    return { ...first.data,
        review: { ...first.data.review, columns_config: columns,
            scope_config: { research_file_id: "workspace-1", subjects: [] } },
        documents: [{ ...first.document, selection: { target: "sources", members: [{ sourceId: "source-1" }] } }] };
};

it("adds workspace sources that are not rows yet", async () => {
    mocks.getTabularReview.mockResolvedValue(scoped([{ index: 0, name: "Term", prompt: "Find term" }]));
    mocks.getResearchFile.mockResolvedValue(workspaceFile({
        "source-1": { id: "source-1", reference: { title: "Lease" }, labelIds: [],
      note: "", passages: null },
        "source-2": { id: "source-2", reference: { title: "Ruling" }, labelIds: [],
      note: "", passages: null },
    }));
    mocks.updateReview.mockResolvedValue({});
    render(<TRView reviewId="review-1" />);
    await screen.findByRole("button", { name: "Term actions" });

    fireEvent.click(screen.getByRole("button", { name: "Add documents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Ruling" }));
    await waitFor(() => expect(mocks.updateReview).toHaveBeenCalledWith("review-1", {
        research_selection: { target: "sources", members: [{ sourceId: "source-1" }, { sourceId: "source-2" }] },
    }));
    expect(screen.queryByRole("button", { name: "Add Lease" })).not.toBeInTheDocument();
});

it("reviews a tag column in the shared dialog before filing it in the workspace", async () => {
    mocks.getTabularReview.mockResolvedValue(scoped([{ index: 3, name: "Outcome", prompt: "Outcome", format: "tag" }]));
    const file = workspaceFile({});
    mocks.getResearchFile.mockResolvedValue(file);
    mocks.ensureWorkspace.mockResolvedValue(file);
    const proposal = { title: "Outcome", labels: [], unassigned: [], fingerprint: "a".repeat(64), design: { labels: [], assignments: [] } };
    mocks.previewWorkspaceLabels.mockResolvedValue(proposal);
    mocks.applyWorkspaceLabels.mockResolvedValue(file);
    render(<TRView reviewId="review-1" />);
    await screen.findByRole("button", { name: "Outcome actions" });

    fireEvent.click(screen.getByRole("button", { name: "Outcome actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Labels from this column" }));
    await waitFor(() => expect(mocks.previewWorkspaceLabels).toHaveBeenCalledWith("workspace-1", {
      tableId: "review-1", columnIndex: 3, selection: { target: "sources", members: [{ sourceId: "source-1" }] }, model: "gpt-5", reasoningEffort: "medium" }));
    const apply = await screen.findByRole("button", { name: "Apply labels" });
    await waitFor(() => expect(apply).toBeEnabled());
    expect(mocks.applyWorkspaceLabels).not.toHaveBeenCalled();
    fireEvent.click(apply);
    await waitFor(() => expect(mocks.applyWorkspaceLabels).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
      tableId: "review-1", columnIndex: 3, fingerprint: proposal.fingerprint, design: proposal.design })));
});

it("discusses the selected column with its actual completed cell references", async () => {
    const data = scoped([{ index: 0, name: "Term", prompt: "Find term" }, { index: 2, name: "Other", prompt: "Other" }]);
    data.cells = [{ ...data.cells[0], content: { summary: "Two years", claims: [], evidence: [], missing: [], coverage: "complete" } },
        { ...data.cells[0], id: "other", column_index: 2, content: { summary: "Not selected", claims: [], evidence: [], missing: [], coverage: "complete" } }];
    mocks.getTabularReview.mockResolvedValue(data);
    const file = workspaceFile({ "source-1": { id: "source-1", reference: { title: "Lease" }, labelIds: [],
      note: "", passages: null } });
    mocks.getResearchFile.mockResolvedValue(file); mocks.ensureWorkspace.mockResolvedValue(file);
    render(<TRView reviewId="review-1" />);
    await screen.findByRole("button", { name: "Term actions" });
    fireEvent.click(screen.getByRole("button", { name: "Term actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Discuss column" }));
    await waitFor(() => expect(screen.getByTestId("discussion")).toHaveAttribute("data-ready", "true"));
    expect(JSON.parse(screen.getByTestId("discussion").getAttribute("data-selection")!)).toMatchObject({
        members: [{ sourceId: "source-1" }], findingRefs: [{ kind: "cell", reviewId: "review-1", rowId: "document-1", columnIndex: 0 }] });
    fireEvent.click(screen.getByRole("button", { name: "Discuss all columns" }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("discussion").getAttribute("data-selection")!).findingRefs).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Term actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Discuss column" }));
    await waitFor(() => expect(screen.getByTestId("discussion")).toHaveAttribute("data-ready", "true"));
    expect(JSON.parse(screen.getByTestId("discussion").getAttribute("data-selection")!).findingRefs).toHaveLength(1);
});

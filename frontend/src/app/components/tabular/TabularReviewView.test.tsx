import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { Document } from "@/app/lib/api/documents";
import type { ColumnConfig, TabularCell, TabularReview } from "@/app/lib/api/tabular";
import { TRView } from "./TabularReviewView";

const mocks = vi.hoisted(() => ({
    getTabularReview: vi.fn(),
    getProject: vi.fn(),
    startGeneration: vi.fn(),
    regenerateCell: vi.fn(),
    updateReview: vi.fn(),
    proposeWorkspaceLabels: vi.fn(),
    applyWorkspaceLabels: vi.fn(),
    getResearchFile: vi.fn(),
    ensureWorkspace: vi.fn(),
}));
function fixture(status: TabularCell["status"]) {
    const document: Document = { id: "document-1", filename: "lease.pdf", project_id: null,
        file_type: "pdf", pdf_storage_path: null, size_bytes: null, page_count: 1, created_at: null };
    const cell: TabularCell = { id: "cell-1", document_id: document.id, column_index: 0, status,
        content: status === "done" ? { summary: "Two years", flag: "green", claims: [], evidence: [],
            outcome: "answered", coverage: "complete" } : null };
    const review: TabularReview = { id: "review-1", title: "Lease review", project_id: null,
        user_id: "user-1", created_at: "2026-09-01T00:00:00Z",
        columns_config: [{ index: 0, name: "Term", prompt: "Find term" }] };
    return { cell, document, data: { review, cells: [cell], documents: [document] } };
}

function renderReview(props: Omit<ComponentProps<typeof TRView>, "reviewId"> = {}) {
    return render(<MemoryRouter initialEntries={["/tabular-reviews/review-1"]}>
        <TRView reviewId="review-1" {...props} />
    </MemoryRouter>);
}

function chooseColumnAction(column: string, action: string) {
    fireEvent.click(screen.getByRole("button", { name: `${column} actions` }));
    fireEvent.click(screen.getByRole("menuitem", { name: action }));
}

beforeEach(() => vi.clearAllMocks());

vi.mock("@/app/lib/api/tabular", async (original) => ({
  ...await original<typeof import("@/app/lib/api/tabular")>(),
  getTabularReview: mocks.getTabularReview,
  regenerateTabularCell: mocks.regenerateCell,
  startTabularGeneration: mocks.startGeneration,
  updateTabularReview: mocks.updateReview,
}));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  getResearchFile: mocks.getResearchFile,
  proposeWorkspaceLabels: mocks.proposeWorkspaceLabels,
  applyWorkspaceLabels: mocks.applyWorkspaceLabels,
  ensureSourcesWorkspace: mocks.ensureWorkspace,
  getResearchItems: vi.fn().mockResolvedValue({ items: [], next_cursor: null, total: 0 }),
  getWorkspaceFindings: vi.fn().mockResolvedValue({ items: [], total: 0, next_offset: null })
}));
vi.mock("../legal/ResearchWorkspaceHost", () => ({ ResearchWorkspaceHost: () => <div>Sources workspace</div> }));
vi.mock("@/app/lib/api/projects", () => ({
  getProject: mocks.getProject,
  listProjects: vi.fn().mockResolvedValue({ items: [], next_cursor: null })
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
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: ({ open, sources, onAddSources }: {
        open: boolean; sources?: { id: string; title: string }[];
        onAddSources?: (ids: string[]) => Promise<void>;
    }) => open ? <>{sources?.map(({ id, title }) => <button key={id}
        onClick={() => void onAddSources?.([id])}>{`Add ${title}`}</button>)}</> : null,
}));

it("projects queued agents into the table", async () => {
    mocks.getTabularReview.mockResolvedValue(fixture("pending").data);
    mocks.startGeneration.mockImplementation(async () => {
        const running = fixture("generating").data;
        mocks.getTabularReview.mockResolvedValue({ ...running, review: { ...running.review, is_running: true } });
        return { job_ids: ["job-1"], queued: 1 };
    });
    renderReview();

    const select = await screen.findByRole("checkbox", { name: "Select lease.pdf" });
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    fireEvent.click(select);
    expect(screen.getByText("1 selected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear results" })).toBeEnabled();
    fireEvent.click(select);
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Term result" }));
    expect(screen.getByRole("region", { name: "Result details" })).toHaveTextContent("This question has not run yet.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByRole("button", { name: "Stop" });
    fireEvent.click(screen.getByRole("button", { name: "Open Term result" }));
    expect(within(screen.getByRole("region", { name: "Result details" })).getByRole("status")).toHaveTextContent("Running…");
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
    expect(mocks.startGeneration).toHaveBeenCalledWith("review-1", {
        model: "gpt-5", reasoningEffort: "medium",
    });
    expect(screen.getByRole("progressbar", { name: "Run progress" })).toHaveAttribute("aria-valuemax", "1");
});

it("reruns a column one row at a time as the review goes idle", async () => {
    const first = fixture("done");
    const second = { id: "document-2", filename: "deed.pdf" } as Document;
    const data = { ...first.data, documents: [first.document, second],
        cells: [first.cell, { ...first.cell, id: "cell-2", document_id: second.id }] };
    mocks.getTabularReview.mockResolvedValue(data);
    mocks.regenerateCell.mockResolvedValue({ job_id: "job-1", queued: true });
    renderReview();
    await screen.findByRole("checkbox", { name: "Select lease.pdf" });

    chooseColumnAction("Term", "Rerun column");
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
    renderReview({ projectId: "project-1" });
    await screen.findByRole("checkbox", { name: "Select lease.pdf" });
    expect(screen.getByText("Two years")).toBeVisible();
    expect(screen.getByRole("img", { name: "Supported" })).toBeVisible();
});

const workspaceFile = (sources: Record<string, unknown>) => ({
    document: { id: "workspace-1" }, versionId: "v1", workingRevision: 0,
    state: { labels: {}, sources, queries: null, note: "" },
});
const scoped = (columns: ColumnConfig[]) => {
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
    renderReview();
    await screen.findByRole("checkbox", { name: "Select lease.pdf" });

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
    mocks.proposeWorkspaceLabels.mockResolvedValue(proposal);
    mocks.applyWorkspaceLabels.mockResolvedValue(file);
    renderReview();
    await screen.findByRole("checkbox", { name: "Select lease.pdf" });

    chooseColumnAction("Outcome", "Labels from this column");
    fireEvent.click(await screen.findByRole("button", { name: "Propose labels" }));
    await waitFor(() => expect(mocks.proposeWorkspaceLabels).toHaveBeenCalledWith("workspace-1", {
      tableId: "review-1", columnIndex: 3, selection: { target: "sources", members: [{ sourceId: "source-1" }] }, model: "gpt-5", reasoningEffort: "medium" }, expect.any(Function), expect.any(AbortSignal)));
    const apply = await screen.findByRole("button", { name: "Apply labels" });
    await waitFor(() => expect(apply).toBeEnabled());
    expect(mocks.applyWorkspaceLabels).not.toHaveBeenCalled();
    fireEvent.click(apply);
    await waitFor(() => expect(mocks.applyWorkspaceLabels).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
      tableId: "review-1", columnIndex: 3, fingerprint: proposal.fingerprint, design: proposal.design })));
});

it("discusses the selected column with its actual completed cell references", async () => {
    const data = scoped([{ index: 0, name: "Term", prompt: "Find term" }, { index: 2, name: "Other", prompt: "Other" }]);
    data.cells = [{ ...data.cells[0], content: { summary: "Two years", claims: [], evidence: [], outcome: "answered", coverage: "complete" } },
        { ...data.cells[0], id: "other", column_index: 2, content: { summary: "Not selected", claims: [], evidence: [], outcome: "answered", coverage: "complete" } }];
    mocks.getTabularReview.mockResolvedValue(data);
    const file = workspaceFile({ "source-1": { id: "source-1", reference: { title: "Lease" }, labelIds: [],
      note: "", passages: null } });
    mocks.getResearchFile.mockResolvedValue(file); mocks.ensureWorkspace.mockResolvedValue(file);
    renderReview();
    await screen.findByRole("checkbox", { name: "Select lease.pdf" });
    chooseColumnAction("Term", "Discuss column");
    await waitFor(() => expect(screen.getByTestId("discussion")).toHaveAttribute("data-ready", "true"));
    expect(JSON.parse(screen.getByTestId("discussion").getAttribute("data-selection")!)).toMatchObject({
        members: [{ sourceId: "source-1" }], findingRefs: [{ kind: "cell", reviewId: "review-1", rowId: "document-1", columnIndex: 0 }] });
    fireEvent.click(screen.getByRole("button", { name: "Discuss all columns" }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("discussion").getAttribute("data-selection")!).findingRefs).toHaveLength(2));
    chooseColumnAction("Term", "Discuss column");
    await waitFor(() => expect(screen.getByTestId("discussion")).toHaveAttribute("data-ready", "true"));
    expect(JSON.parse(screen.getByTestId("discussion").getAttribute("data-selection")!).findingRefs).toHaveLength(1);
});

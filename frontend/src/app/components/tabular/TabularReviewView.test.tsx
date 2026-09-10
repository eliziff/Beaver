import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ColumnConfig, TabularCell, TabularDocument, TabularReview } from "@/app/lib/api/tabular";
import { TRView } from "./TabularReviewView";

const mocks = vi.hoisted(() => ({
    getTabularReview: vi.fn(), getProject: vi.fn(), listProjects: vi.fn(),
    startGeneration: vi.fn(), regenerateCell: vi.fn(), updateReview: vi.fn(),
    previewWorkspaceLabels: vi.fn(), applyWorkspaceLabels: vi.fn(),
    getResearchFile: vi.fn(), ensureWorkspace: vi.fn(),
}));
vi.mock("@/app/lib/api/tabular", async (original) => ({
    ...await original<typeof import("@/app/lib/api/tabular")>(),
    getTabularReview: mocks.getTabularReview, regenerateTabularCell: mocks.regenerateCell,
    startTabularGeneration: mocks.startGeneration, updateTabularReview: mocks.updateReview,
}));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({
    ...await original<typeof import("@/app/lib/api/researchFiles")>(),
    getResearchFile: mocks.getResearchFile, ensureSourcesWorkspace: mocks.ensureWorkspace,
    previewWorkspaceLabels: mocks.previewWorkspaceLabels, applyWorkspaceLabels: mocks.applyWorkspaceLabels,
}));
vi.mock("@/app/lib/api/documents", async (original) => ({
    ...await original<typeof import("@/app/lib/api/documents")>(),
    directoryResource: () => ({ list: async () => ({ items: [], next_cursor: null }) }),
}));
vi.mock("@/app/lib/api/projects", async (original) => ({
    ...await original<typeof import("@/app/lib/api/projects")>(),
    getProject: mocks.getProject, listProjects: mocks.listProjects,
}));
vi.mock("@/app/contexts/AuthContext", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useUserProfile: () => ({ profile: null }) }));
vi.mock("@/app/contexts/SidebarContext", () => ({ useSidebar: () => ({ setSidebarOpen: vi.fn() }) }));
vi.mock("@/app/hooks/useSelectedModel", () => ({
    useSelectedModel: () => ["gpt-5"], useSelectedReasoningEffort: () => ["medium"],
}));
// Observe the chat boundary without starting a second assistant. Table, header,
// result panel, menus and source picker are the production components.
vi.mock("./TRChatPanel", async () => {
    const { useSourcesWorkspace } = await import("../legal/SourcesWorkspace");
    return { TRChatPanel: ({ workspaceReady, scopeLabel, onClearScope }: {
        workspaceReady: boolean; scopeLabel?: string; onClearScope?: () => void;
    }) => {
        const workspace = useSourcesWorkspace();
        return <div data-testid="discussion" data-ready={String(workspaceReady)} data-selection={JSON.stringify(workspace.selection)}>
            {scopeLabel}<button onClick={onClearScope}>Discuss all columns</button></div>;
    } };
});

beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listProjects.mockResolvedValue({ items: [], next_cursor: null });
});

function fixture(status: TabularCell["status"]) {
    const document: TabularDocument = { id: "document-1", filename: "lease.pdf", project_id: null,
        file_type: "pdf", pdf_storage_path: null, size_bytes: 12, page_count: 1, created_at: "2026-09-01" };
    const cell: TabularCell = { id: "cell-1", document_id: document.id, column_index: 0, content: null, status };
    const review: TabularReview = { id: "review-1", title: "Lease review", project_id: null,
        user_id: "owner", created_at: "2026-09-01", columns_config: [{ index: 0, name: "Term", prompt: "Find term" }] };
    return { cell, document, data: { review, cells: [cell], documents: [document] } };
}

async function openReview(projectId?: string) {
    render(<MemoryRouter initialEntries={["/tabular-reviews/review-1"]}>
        <TRView reviewId="review-1" projectId={projectId} />
    </MemoryRouter>);
    await screen.findByRole("checkbox", { name: "Select lease.pdf" });
}

function columnAction(column: string, action: string) {
    fireEvent.click(screen.getByRole("button", { name: `${column} actions` }));
    fireEvent.click(screen.getByRole("menuitem", { name: action }));
}

it("projects queued agents into the table", async () => {
    mocks.getTabularReview.mockResolvedValue(fixture("pending").data);
    mocks.startGeneration.mockImplementation(async () => {
        const running = fixture("generating").data;
        mocks.getTabularReview.mockResolvedValue({ ...running, review: { ...running.review, is_running: true } });
        return { job_ids: ["job-1"], queued: 1 };
    });
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("button", { name: "Stop" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Term result" }));
    const panel = within(screen.getByRole("dialog", { name: "Term result" }));
    expect(panel.getByRole("status")).toHaveTextContent("Running…");
    expect(panel.getByRole("button", { name: "Regenerate" })).toBeDisabled();
    expect(mocks.startGeneration).toHaveBeenCalledWith("review-1", {
        model: "gpt-5", reasoningEffort: "medium",
    });
    expect(screen.getByRole("progressbar", { name: "Run progress" })).toHaveAttribute("aria-valuemax", "1");
});

it("reruns a column one row at a time as the review goes idle", async () => {
    const first = fixture("done");
    const second = { ...first.document, id: "document-2", filename: "deed.pdf" };
    const data = { ...first.data, documents: [first.document, second],
        cells: [first.cell, { ...first.cell, id: "cell-2", document_id: second.id }] };
    mocks.getTabularReview.mockResolvedValue(data);
    mocks.regenerateCell.mockResolvedValue({ job_id: "job-1", queued: true });
    await openReview();

    columnAction("Term", "Rerun column");
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
    await openReview("project-1");
    expect(screen.getByRole("button", { name: "Open Term result" })).toBeEnabled();
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
    await openReview();

    fireEvent.click(screen.getByRole("button", { name: "Add documents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sources" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Ruling" }));
    expect(screen.queryByRole("checkbox", { name: "Select Lease" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mocks.updateReview).toHaveBeenCalledWith("review-1", {
        research_selection: { target: "sources", members: [{ sourceId: "source-1" }, { sourceId: "source-2" }] },
    }));
});

it("reviews a tag column in the shared dialog before filing it in the workspace", async () => {
    mocks.getTabularReview.mockResolvedValue(scoped([{ index: 3, name: "Outcome", prompt: "Outcome", format: "tag" }]));
    const file = workspaceFile({});
    mocks.getResearchFile.mockResolvedValue(file);
    mocks.ensureWorkspace.mockResolvedValue(file);
    const proposal = { title: "Outcome", labels: [], unassigned: [], fingerprint: "a".repeat(64), design: { labels: [], assignments: [] } };
    mocks.previewWorkspaceLabels.mockResolvedValue(proposal);
    mocks.applyWorkspaceLabels.mockResolvedValue(file);
    await openReview();

    columnAction("Outcome", "Labels from this column");
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
    data.cells = [{ ...data.cells[0], content: { summary: "Two years", claims: [], evidence: [], outcome: "answered", coverage: "complete" } },
        { ...data.cells[0], id: "other", column_index: 2, content: { summary: "Not selected", claims: [], evidence: [], outcome: "answered", coverage: "complete" } }];
    mocks.getTabularReview.mockResolvedValue(data);
    const file = workspaceFile({ "source-1": { id: "source-1", reference: { title: "Lease" }, labelIds: [],
      note: "", passages: null } });
    mocks.getResearchFile.mockResolvedValue(file); mocks.ensureWorkspace.mockResolvedValue(file);
    await openReview();
    columnAction("Term", "Discuss column");
    await waitFor(() => expect(screen.getByTestId("discussion")).toHaveAttribute("data-ready", "true"));
    expect(JSON.parse(screen.getByTestId("discussion").getAttribute("data-selection")!)).toMatchObject({
        members: [{ sourceId: "source-1" }], findingRefs: [{ kind: "cell", reviewId: "review-1", rowId: "document-1", columnIndex: 0 }] });
    fireEvent.click(screen.getByRole("button", { name: "Discuss all columns" }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("discussion").getAttribute("data-selection")!).findingRefs).toHaveLength(2));
    columnAction("Term", "Discuss column");
    await waitFor(() => expect(screen.getByTestId("discussion")).toHaveAttribute("data-ready", "true"));
    expect(JSON.parse(screen.getByTestId("discussion").getAttribute("data-selection")!).findingRefs).toHaveLength(1);
});

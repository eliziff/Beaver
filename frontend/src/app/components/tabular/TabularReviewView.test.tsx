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
}));
function fixture(status: TabularCell["status"]) {
    const document = { id: "document-1", filename: "lease.pdf" } as Document;
    const cell = {
        id: "cell-1",
        document_id: document.id,
        column_index: 0,
        content: null,
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
  updateTabularReview: vi.fn()
}));
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
vi.mock("../shared/PageHeader", () => ({
    PageHeader: ({
        actions,
    }: {
        actions?: {
            label?: React.ReactNode;
            onClick?: () => void;
            disabled?: boolean;
        }[];
    }) => (
        <>
            {actions?.map((action, index) =>
                action?.label ? (
                    <button
                        key={index}
                        disabled={action.disabled}
                        onClick={action.onClick}
                    >
                        {action.label}
                    </button>
                ) : null,
            )}
        </>
    ),
}));
vi.mock("./TRTable", () => ({
    TRTable: ({
        loading,
        cells,
        columns,
        documents,
        selectedDocIds,
        onExpand,
        onSelectionChange,
        onRerunColumn,
    }: {
        loading: boolean;
        cells: TabularCell[];
        columns: { index: number }[];
        documents: Document[];
        selectedDocIds: string[];
        onExpand: (cell: TabularCell) => void;
        onSelectionChange: (ids: string[]) => void;
        onRerunColumn: (column: { index: number }) => void;
    }) => (
        <>
            <button
                data-testid="table"
                data-loading={loading}
                data-status={cells[0]?.status}
                data-content={JSON.stringify(cells[0]?.content)}
                onClick={() => onExpand(cells[0])}
            >
                Open cell
            </button>
            <button onClick={() => onSelectionChange(selectedDocIds.length ? [] : documents.map(({ id }) => id))}>Toggle rows</button>
            <button onClick={() => onRerunColumn(columns[0])}>Rerun first column</button>
        </>
    ),
}));
vi.mock("./TRSidePanel", () => ({
    TRSidePanel: ({ cell }: { cell: TabularCell }) => (
        <div data-testid="cell-details" data-status={cell.status}>
            Cell details
        </div>
    ),
}));
vi.mock("./TRChatPanel", () => ({ TRChatPanel: () => null }));
vi.mock("./AddColumnModal", () => ({ AddColumnModal: () => null }));
vi.mock("./TabularReviewDetailsModal", () => ({
    TabularReviewDetailsModal: () => null,
}));
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
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
    mocks.startGeneration.mockResolvedValue({ job_ids: ["job-1"], queued: 1 });
    render(<TRView reviewId="review-1" />);

    await waitFor(() =>
        expect(screen.getByTestId("table")).toHaveAttribute(
            "data-loading",
            "false",
        ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open cell" }));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
        expect(screen.getByTestId("table")).toHaveAttribute(
            "data-status",
            "generating",
        ),
    );
    expect(screen.getByTestId("cell-details")).toHaveAttribute(
        "data-status",
        "generating",
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
    expect(mocks.startGeneration).toHaveBeenCalledWith("review-1", {
        model: "gpt-5", reasoningEffort: "medium",
    });
    expect(screen.getByRole("progressbar", { name: "Run progress" })).toHaveAttribute("aria-valuemax", "1");
});

it("shows row actions only while rows are selected", async () => {
    mocks.getTabularReview.mockResolvedValue(fixture("done").data);
    render(<TRView reviewId="review-1" />);
    await waitFor(() => expect(screen.getByTestId("table")).toHaveAttribute("data-loading", "false"));
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle rows" }));
    expect(screen.getByText("1 selected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear results" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Toggle rows" }));
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
    await waitFor(() => expect(screen.getByTestId("table")).toHaveAttribute("data-loading", "false"));

    fireEvent.click(screen.getByRole("button", { name: "Rerun first column" }));
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
    await waitFor(() => expect(screen.getByTestId("table")).toHaveAttribute("data-loading", "false"));
    expect(screen.getByTestId("table")).toHaveAttribute("data-status", "done");
});

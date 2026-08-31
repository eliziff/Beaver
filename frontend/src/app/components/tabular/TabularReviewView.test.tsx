import {
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Document, TabularCell, TabularReview } from "../shared/types";
import { TRView } from "./TabularReviewView";

const mocks = vi.hoisted(() => ({
    getTabularReview: vi.fn(),
    listProjects: vi.fn(),
    startGeneration: vi.fn(),
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
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock("@/app/lib/beaverApi", () => ({
    clearTabularCells: vi.fn(),
    deleteTabularReview: vi.fn(),
    directoryResource: () => ({ uploadDocument: mocks.uploadDocument }),
    getProject: vi.fn(),
    getTabularReview: mocks.getTabularReview,
    getTabularReviewPeople: vi.fn(),
    listProjects: mocks.listProjects,
    regenerateTabularCell: vi.fn(),
    startTabularGeneration: mocks.startGeneration,
    stopTabularGeneration: vi.fn(),
    updateTabularReview: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
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
vi.mock("../shared/TableToolbar", () => ({
    TableToolbar: ({ actions }: { actions: React.ReactNode }) => actions,
}));
vi.mock("./TRTable", () => ({
    TRTable: ({
        loading,
        cells,
        onExpand,
    }: {
        loading: boolean;
        cells: TabularCell[];
        onExpand: (cell: TabularCell) => void;
    }) => (
        <button
            data-testid="table"
            data-loading={loading}
            data-status={cells[0]?.status}
            data-content={JSON.stringify(cells[0]?.content)}
            onClick={() => onExpand(cells[0])}
        >
            Open cell
        </button>
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
});

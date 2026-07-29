import { Profiler } from "react";
import {
    act,
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
    streamGeneration: vi.fn(),
    commits: 0,
}));
function fixture(status: TabularCell["status"]) {
    const document = { id: "document-1", filename: "lease.pdf" } as Document;
    const cell = {
        id: "cell-1",
        review_id: "review-1",
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

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/lib/beaverApi", () => ({
    clearTabularCells: vi.fn(),
    deleteTabularReview: vi.fn(),
    getProject: vi.fn(),
    getTabularReview: mocks.getTabularReview,
    getTabularReviewPeople: vi.fn(),
    listProjects: mocks.listProjects,
    regenerateTabularCell: vi.fn(),
    streamTabularGeneration: mocks.streamGeneration,
    updateTabularReview: vi.fn(),
    uploadProjectDocument: vi.fn(),
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

it("opens a loaded cell without redundant commits", async () => {
    let finishProjects!: (projects: []) => void;
    mocks.listProjects.mockReturnValue(
        new Promise((resolve) => {
            finishProjects = resolve;
        }),
    );
    const { data } = fixture("done");
    mocks.getTabularReview.mockResolvedValue(data);
    mocks.commits = 0;
    render(
        <Profiler id="review" onRender={() => mocks.commits++}>
            <TRView reviewId="review-1" />
        </Profiler>,
    );

    await act(async () => {});
    expect(mocks.commits).toBe(1);
    await act(() => finishProjects([]));
    await waitFor(() =>
        expect(screen.getByTestId("table")).toHaveAttribute(
            "data-loading",
            "false",
        ),
    );
    const beforeOpen = mocks.commits;
    fireEvent.click(screen.getByRole("button", { name: "Open cell" }));

    expect(beforeOpen).toBe(2);
    expect(screen.getByText("Cell details")).toBeInTheDocument();
    expect(mocks.commits - beforeOpen).toBe(1);
});

it("ignores generating events after cells are premarked", async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    mocks.listProjects.mockResolvedValue([]);
    mocks.getTabularReview.mockResolvedValue(fixture("pending").data);
    mocks.streamGeneration.mockResolvedValue(
        new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    streamController = controller;
                },
            }),
        ),
    );
    mocks.commits = 0;
    render(
        <Profiler id="review" onRender={() => mocks.commits++}>
            <TRView reviewId="review-1" />
        </Profiler>,
    );

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
    const commitsAfterPremark = mocks.commits;
    await act(async () => {
        streamController.enqueue(
            encoder.encode(
                'data: {"type":"cell_update","document_id":"document-1","column_index":0,"content":null,"status":"generating"}\n\n',
            ),
        );
    });
    expect(mocks.commits).toBe(commitsAfterPremark);

    await act(async () => {
        streamController.enqueue(
            encoder.encode(
                'data: {"type":"cell_update","document_id":"document-1","column_index":0,"content":{"summary":"Five years"},"status":"done"}\n\ndata: [DONE]\n\n',
            ),
        );
        streamController.close();
    });
    await waitFor(() =>
        expect(screen.getByTestId("table")).toHaveAttribute(
            "data-status",
            "done",
        ),
    );
    expect(screen.getByTestId("table")).toHaveAttribute(
        "data-content",
        JSON.stringify({ summary: "Five years" }),
    );
    expect(screen.getByTestId("cell-details")).toHaveAttribute(
        "data-status",
        "done",
    );
});

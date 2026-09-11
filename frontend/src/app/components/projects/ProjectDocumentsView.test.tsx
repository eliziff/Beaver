import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { Document } from "@/app/lib/api/documents";
import type { WorkflowSelection } from "../workflows/workflowRoutes";
import { assistantWorkflowLaunch } from "../workflows/workflowRoutes";
import { ProjectDocumentsView } from "./ProjectDocumentsView";
import { ProjectWorkspaceProvider } from "./ProjectWorkspace";

const mocks = vi.hoisted(() => ({ saveChat: vi.fn() }));
const source: Document = {
    id: "brief", project_id: "project-1", filename: "Brief.docx",
    file_type: "docx", pdf_storage_path: null, size_bytes: 10,
    page_count: 1, created_at: "2026-08-31T00:00:00Z",
};
const selection = {
    workflow: { id: "drafting", metadata: { title: "Drafting" } },
    variant: { id: "proofread", execution: "assistant" },
} as WorkflowSelection;

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "local-user", email: "lawyer@example.test" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { displayName: "Lawyer" } }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ saveChat: mocks.saveChat }),
}));
vi.mock("@/app/lib/api/projects", async (original) => ({
    ...await original<typeof import("@/app/lib/api/projects")>(),
    getProject: async () => ({
        id: "project-1", user_id: "local-user", name: "Appeal",
        cm_number: null, practice: null, shared_with: [],
        created_at: "2026-08-31T00:00:00Z",
    }),
}));
vi.mock("./useProjectFiles", () => ({
    useProjectFiles: () => ({
        documents: [source], folders: [], loading: false, operations: {},
        hasMoreParents: new Set(), loadingParents: new Set(),
        onFolderExpanded: vi.fn(), onLoadMore: vi.fn(),
    }),
}));
vi.mock("../documents/DocTable", () => ({
    DocTable: ({ onAssistantWorkflowSelect }: {
        onAssistantWorkflowSelect: (
            selection: WorkflowSelection, documents: Document[],
        ) => void;
    }) => <button type="button"
        onClick={() => onAssistantWorkflowSelect(selection, [source])}>
        Proofread selected
    </button>,
}));

function Location() {
    const location = useLocation();
    return <output aria-label="Location">{JSON.stringify({
        pathname: location.pathname, state: location.state,
    })}</output>;
}

beforeEach(() => {
    sessionStorage.clear();
    mocks.saveChat.mockReset().mockResolvedValue("chat-1");
});

it("creates a project chat carrying the selected workflow and documents", async () => {
    render(<MemoryRouter initialEntries={["/projects/project-1"]}>
        <ProjectWorkspaceProvider projectId="project-1">
            <ProjectDocumentsView />
            <Location />
        </ProjectWorkspaceProvider>
    </MemoryRouter>);

    await userEvent.click(screen.getByRole("button", { name: "Proofread selected" }));

    await waitFor(() => expect(screen.getByRole("status", { name: "Location" }))
        .toHaveTextContent(JSON.stringify({
            pathname: "/projects/project-1/assistant/chat/chat-1",
            state: assistantWorkflowLaunch(selection),
        })));
    expect(JSON.parse(sessionStorage.getItem("beaver:new-chat-documents") ?? "[]"))
        .toEqual([source]);
});

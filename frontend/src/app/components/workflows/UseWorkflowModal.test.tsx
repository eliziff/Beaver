import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { UseWorkflowModal } from "./UseWorkflowModal";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    saveChat: vi.fn().mockResolvedValue("chat-1"),
    stagePendingChatMessage: vi.fn(),
}));
vi.mock("react-router-dom", () => ({
    useNavigate: () => mocks.push,
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        saveChat: mocks.saveChat,
        stagePendingChatMessage: mocks.stagePendingChatMessage,
    }),
}));
vi.mock("../shared/useDirectoryData", () => ({
    useDirectoryData: () => ({ loading: false, projects: [] }),
}));
vi.mock("../shared/FileDirectory", () => ({
    FileDirectory: () => <div>Documents</div>,
}));

const workflow = {
    id: "workflow-1",
    user_id: "user-1",
    metadata: {
        title: "Review lease",
        description: null,
        type: "assistant",
        contributors: [],
        language: "English",
        version: null,
        practice: null,
        jurisdictions: null,
    },
    skill_md: null,
    columns_config: null,
    is_system: false,
    created_at: "2026-07-29T00:00:00.000Z",
} satisfies Workflow;

it("keeps an additional message through the document step", async () => {
    render(
        <UseWorkflowModal
            workflow={workflow}
            onClose={vi.fn()}
        />,
    );

    expect(
        screen.queryByPlaceholderText("Search workflows..."),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Additional message"), {
        target: { value: "Focus on indemnities" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Chat" }));

    await waitFor(() =>
        expect(mocks.stagePendingChatMessage).toHaveBeenCalledWith(
            "chat-1",
            expect.objectContaining({
                content: "implement workflow\nFocus on indemnities",
            }),
        ),
    );
});

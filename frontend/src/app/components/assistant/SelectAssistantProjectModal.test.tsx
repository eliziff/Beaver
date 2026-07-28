import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SelectAssistantProjectModal } from "./SelectAssistantProjectModal";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    saveChat: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ saveChat: mocks.saveChat }),
}));
vi.mock("../shared/useDirectoryData", () => ({
    useDirectoryData: () => ({
        loading: false,
        projects: [
            {
                id: "project-1",
                name: "Matter One",
                document_count: 2,
            },
            {
                id: "project-2",
                name: "Matter Two",
                document_count: 0,
            },
        ],
    }),
}));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveChat.mockResolvedValue("chat-1");
});

describe("SelectAssistantProjectModal", () => {
    it("creates and navigates to a chat under the selected project", async () => {
        const user = userEvent.setup();
        render(
            <SelectAssistantProjectModal
                open
                onClose={vi.fn()}
            />,
        );

        const project = screen.getByRole("option", { name: /Matter One/ });
        const continueButton = screen.getByRole("button", {
            name: "Continue",
        });
        await user.click(project);
        expect(continueButton).toBeEnabled();
        await user.click(project);
        expect(continueButton).toBeDisabled();
        await user.click(project);
        await user.click(continueButton);

        await waitFor(() => {
            expect(mocks.saveChat).toHaveBeenCalledWith("project-1");
            expect(mocks.push).toHaveBeenCalledWith(
                "/projects/project-1/assistant/chat/chat-1",
            );
        });
    });

    it("reuses the picker to change or unlink an existing chat", async () => {
        const user = userEvent.setup();
        const onSelectProject = vi.fn().mockResolvedValue(undefined);
        render(
            <SelectAssistantProjectModal
                open
                onClose={vi.fn()}
                chatTitle="Lease review"
                currentProjectId="project-1"
                onSelectProject={onSelectProject}
            />,
        );

        expect(
            screen.getByRole("dialog", {
                name: "Move “Lease review” to a project",
            }),
        ).toHaveTextContent("Current location: Matter One");
        const noProject = screen.getByRole("button", {
            name: "Assistant (no project)",
        });
        expect(noProject).toHaveAttribute("aria-pressed", "false");
        await user.click(noProject);
        expect(noProject).toHaveAttribute("aria-pressed", "true");
        await user.click(screen.getByRole("button", { name: "Move chat" }));

        expect(onSelectProject).toHaveBeenCalledWith(null);
        expect(mocks.saveChat).not.toHaveBeenCalled();
    });
});

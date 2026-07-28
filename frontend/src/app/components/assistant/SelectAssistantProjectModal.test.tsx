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

        await user.click(
            screen.getByRole("button", { name: /Matter One/ }),
        );
        await user.click(screen.getByRole("button", { name: "Continue" }));

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
                currentProjectId="project-1"
                onSelectProject={onSelectProject}
            />,
        );

        await user.click(screen.getByRole("button", { name: "No project" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(onSelectProject).toHaveBeenCalledWith(null);
        expect(mocks.saveChat).not.toHaveBeenCalled();
    });
});

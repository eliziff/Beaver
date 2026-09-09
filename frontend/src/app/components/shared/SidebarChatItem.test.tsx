import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarChatItem } from "./SidebarChatItem";

const mocks = vi.hoisted(() => ({
    renameChat: vi.fn(),
    deleteChat: vi.fn(),
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        renameChat: mocks.renameChat,
        deleteChat: mocks.deleteChat,
    }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/app/components/popups/OwnerOnlyPopup", () => ({
    OwnerOnlyPopup: () => null,
}));

const chat = {
    id: "chat-1",
    project_id: null,
    user_id: "user-1",
    title: "Lease review",
    created_at: "2026-07-27T00:00:00Z",
};

function renderSidebar(props: Partial<ComponentProps<typeof SidebarChatItem>> = {}) {
    return render(<MemoryRouter><SidebarChatItem chat={chat} isActive
        to="/assistant/chat/chat-1" {...props} /></MemoryRouter>);
}

describe("SidebarChatItem inline actions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.deleteChat.mockResolvedValue(undefined);
    });

    it("renames a chat without opening a dropdown framework", async () => {
        renderSidebar();

        expect(screen.getByRole("link", { name: "Lease review" })).toHaveAttribute(
            "href",
            "/assistant/chat/chat-1",
        );
        expect(screen.getByRole("link", { name: "Lease review" })).toHaveAttribute(
            "aria-current",
            "page",
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Rename Lease review" }),
        );
        const input = screen.getByDisplayValue("Lease review");
        fireEvent.change(input, { target: { value: "Updated lease" } });
        fireEvent.keyDown(input, { key: "Enter" });

        await waitFor(() =>
            expect(mocks.renameChat).toHaveBeenCalledWith(
                "chat-1",
                "Updated lease",
            ),
        );
    });

    it("warns before moving a chat to the Recycling bin", async () => {
        renderSidebar();

        fireEvent.click(
            screen.getByRole("button", { name: "Delete Lease review" }),
        );

        expect(mocks.deleteChat).not.toHaveBeenCalled();
        expect(screen.getByRole("alertdialog")).toHaveTextContent(
            "Move chat to Recycling bin?",
        );
        fireEvent.click(screen.getByRole("button", { name: "Move" }));
        await waitFor(() =>
            expect(mocks.deleteChat).toHaveBeenCalledWith("chat-1"),
        );
    });

    it("offers to move the full current selection from its action owner", async () => {
        const onDeleteSelection = vi.fn().mockResolvedValue(undefined);
        renderSidebar({ isSelected: true, selectedCount: 3,
            isSelectionActionOwner: true, onDeleteSelection });

        fireEvent.click(
            screen.getByRole("button", {
                name: "Delete 3 selected chats",
            }),
        );
        expect(screen.getByRole("alertdialog")).toHaveTextContent(
            "Move 3 chats to Recycling bin?",
        );
        fireEvent.click(screen.getByRole("button", { name: "Move" }));

        await waitFor(() =>
            expect(onDeleteSelection).toHaveBeenCalledOnce(),
        );
        expect(mocks.deleteChat).not.toHaveBeenCalled();
    });

    it("cancels the delete warning with Escape", async () => {
        renderSidebar();
        const trigger = screen.getByRole("button", {
            name: "Delete Lease review",
        });
        trigger.focus();
        fireEvent.click(trigger);
        fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

        expect(mocks.deleteChat).not.toHaveBeenCalled();
        expect(screen.queryByRole("alertdialog")).toBeNull();
        await waitFor(() => expect(trigger).toHaveFocus());
    });
});

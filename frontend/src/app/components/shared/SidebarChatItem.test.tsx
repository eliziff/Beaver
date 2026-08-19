import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
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

function renderSidebar(item: ReactElement) {
    return render(<MemoryRouter>{item}</MemoryRouter>);
}

describe("SidebarChatItem inline actions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.deleteChat.mockResolvedValue(undefined);
    });

    it("renames a chat without opening a dropdown framework", async () => {
        renderSidebar(
            <SidebarChatItem
                chat={chat}
                isActive
                to="/assistant/chat/chat-1"
            />,
        );

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

    it("exposes modifier selection and a draggable selected state", () => {
        const onSelect = vi.fn();
        const onNavigate = vi.fn();
        renderSidebar(
            <SidebarChatItem
                chat={chat}
                isActive={false}
                isSelected
                to="/assistant/chat/chat-1"
                onNavigate={onNavigate}
                onSelect={onSelect}
            />,
        );

        const link = screen.getByRole("link", {
            name: "Lease review, selected",
        });
        expect(link.closest("[draggable]")).toHaveAttribute(
            "data-selected",
            "true",
        );
        fireEvent.click(link, { ctrlKey: true });
        expect(onSelect).toHaveBeenCalledOnce();
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it("warns before moving a chat to the Recycling bin", async () => {
        renderSidebar(
            <SidebarChatItem
                chat={chat}
                isActive
                to="/assistant/chat/chat-1"
            />,
        );

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
        renderSidebar(
            <SidebarChatItem
                chat={chat}
                isActive
                isSelected
                selectedCount={3}
                isSelectionActionOwner
                onDeleteSelection={onDeleteSelection}
                to="/assistant/chat/chat-1"
            />,
        );

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

    it("opens the shared project chooser from a stable inline action", () => {
        const onMoveToProject = vi.fn();
        renderSidebar(
            <SidebarChatItem
                chat={chat}
                isActive
                to="/assistant/chat/chat-1"
                onMoveToProject={onMoveToProject}
            />,
        );

        const move = screen.getByRole("button", {
            name: "Move Lease review to project",
        });
        fireEvent.click(move);
        expect(onMoveToProject).toHaveBeenCalledOnce();
    });

    it("cancels the delete warning with Escape", async () => {
        renderSidebar(
            <SidebarChatItem
                chat={chat}
                isActive
                to="/assistant/chat/chat-1"
            />,
        );
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

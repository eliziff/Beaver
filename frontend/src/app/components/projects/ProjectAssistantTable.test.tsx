import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Chat } from "@/app/components/shared/types";
import { ProjectAssistantTable } from "./ProjectAssistantTable";

const chats: Chat[] = ["First chat", "Second chat"].map((title, index) => ({
    id: `chat-${index + 1}`,
    project_id: "project-1",
    user_id: "user-1",
    title,
    created_at: "2026-08-31T00:00:00.000Z",
}));

it("selects visible chats and runs their bulk action", () => {
    const setSelectedChatIds = vi.fn();
    const onDeleteSelected = vi.fn();
    const props = {
        chats,
        filteredChats: chats,
        renamingChatId: null,
        renameChatValue: "",
        currentUserId: "user-1",
        onOpenChat: vi.fn(),
        onDeleteChat: vi.fn(),
        onDeleteSelected,
        onOwnerOnlyAction: vi.fn(),
        submitChatRename: vi.fn(),
        setSelectedChatIds,
        setRenamingChatId: vi.fn(),
        setRenameChatValue: vi.fn(),
    };
    const { rerender } = render(
        <ProjectAssistantTable {...props} selectedChatIds={[]} />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select loaded chats" }));
    expect(setSelectedChatIds).toHaveBeenCalledWith(chats.map(({ id }) => id));

    rerender(<ProjectAssistantTable {...props} selectedChatIds={[chats[0].id]} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDeleteSelected).toHaveBeenCalledOnce();
});

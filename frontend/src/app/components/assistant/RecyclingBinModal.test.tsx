import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecyclingBinModal } from "./RecyclingBinModal";

const mocks = vi.hoisted(() => ({
    listDeletedChats: vi.fn(),
    restoreChat: vi.fn(),
    permanentlyDeleteChat: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", () => mocks);

const deletedChat = {
    id: "chat-1",
    project_id: "project-1",
    user_id: "user-1",
    title: "Lease review",
    created_at: "2026-07-20T00:00:00Z",
    deleted_at: "2026-07-26T00:00:00Z",
};

describe("RecyclingBinModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listDeletedChats.mockResolvedValue([deletedChat]);
        mocks.restoreChat.mockResolvedValue(undefined);
        mocks.permanentlyDeleteChat.mockResolvedValue(undefined);
    });

    it("restores a project chat and refreshes active history", async () => {
        const onRestored = vi.fn().mockResolvedValue(undefined);
        render(
            <RecyclingBinModal
                open
                onClose={vi.fn()}
                onRestored={onRestored}
            />,
        );

        expect(await screen.findByText("Lease review")).toBeVisible();
        expect(screen.getByText(/Project chat/)).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Restore" }));

        await waitFor(() =>
            expect(mocks.restoreChat).toHaveBeenCalledWith("chat-1"),
        );
        expect(onRestored).toHaveBeenCalledOnce();
        expect(screen.queryByText("Lease review")).toBeNull();
    });

    it("requires a second warning before permanent deletion", async () => {
        render(
            <RecyclingBinModal
                open
                onClose={vi.fn()}
                onRestored={vi.fn()}
            />,
        );
        await screen.findByText("Lease review");
        fireEvent.click(
            screen.getByRole("button", {
                name: "Permanently delete Lease review",
            }),
        );

        expect(mocks.permanentlyDeleteChat).not.toHaveBeenCalled();
        expect(screen.getByRole("alertdialog")).toHaveTextContent(
            "Permanently delete chat?",
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Delete permanently" }),
        );
        await waitFor(() =>
            expect(mocks.permanentlyDeleteChat).toHaveBeenCalledWith("chat-1"),
        );
    });
});

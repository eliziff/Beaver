import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatResearchSave } from "./ChatResearchSave";

const api = vi.hoisted(() => ({
  createResearchSet: vi.fn(),
  listResearchSets: vi.fn(),
  promoteChatResearch: vi.fn(),
}));
vi.mock("@/app/lib/beaverApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/beaverApi")>()),
  ...api,
}));

describe("ChatResearchSave", () => {
  it("promotes all chat research to a valid set with optional query receipts", async () => {
    api.listResearchSets.mockResolvedValue([{
      id: "set-1", kind: "research-set", title: "Fairness", projectId: null,
      revision: 3, state: {}, outputs: {}, createdAt: "now", updatedAt: "now",
    }]);
    api.promoteChatResearch.mockResolvedValue({ research_set_id: "set-1", revision: 4 });
    render(<ChatResearchSave chatId="chat-1" projectId="matter-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Save research" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Include model queries and match receipts"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save research" }));

    await waitFor(() => expect(api.promoteChatResearch).toHaveBeenCalledWith({
      chatId: "chat-1", researchSetId: "set-1", revision: 3, includeQueries: true,
    }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
  });

  it("creates new chat research in the current project", async () => {
    api.listResearchSets.mockResolvedValue([]);
    api.createResearchSet.mockResolvedValue({
      id: "set-new", kind: "research-set", title: "Saved research", projectId: "matter-2",
      revision: 1, state: {}, outputs: {}, createdAt: "now", updatedAt: "now",
    });
    api.promoteChatResearch.mockResolvedValue({ research_set_id: "set-new", revision: 2 });
    render(<ChatResearchSave chatId="chat-2" projectId="matter-2" />);

    fireEvent.click(screen.getByRole("button", { name: "Save research" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save research" }));

    await waitFor(() => expect(api.createResearchSet).toHaveBeenCalledWith({
      title: "Saved research", projectId: "matter-2",
    }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
  });
});

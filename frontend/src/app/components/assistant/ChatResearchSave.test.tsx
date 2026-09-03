import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatResearchSave } from "./ChatResearchSave";

const api = vi.hoisted(() => ({ createResearchFile: vi.fn(), getResearchFile: vi.fn(),
  listResearchFiles: vi.fn(), promoteChatResearch: vi.fn() }));
vi.mock("@/app/lib/beaverApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/beaverApi")>()), ...api,
}));
const document = { id: "file-1", filename: "Fairness.research.md", file_type: "md",
  project_id: null, pdf_storage_path: null, size_bytes: 1, page_count: null,
  created_at: null, current_version_id: "version-3" };
const file = { document, versionId: "version-3", state: {} };

describe("ChatResearchSave", () => {
  beforeEach(() => { vi.clearAllMocks(); api.listResearchFiles.mockResolvedValue([]); });

  it("saves chat receipts to an existing ordinary research file", async () => {
    api.listResearchFiles.mockResolvedValueOnce([document]); api.getResearchFile.mockResolvedValue(file);
    render(<ChatResearchSave chatId="chat-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Save research" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Include model queries and match receipts"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save research" }));
    await waitFor(() => expect(api.promoteChatResearch).toHaveBeenCalledWith({
      chatId: "chat-1", researchFileId: "file-1", versionId: "version-3", includeQueries: true,
    }));
  });

  it("creates the default file in the current project", async () => {
    api.createResearchFile.mockResolvedValue(file);
    render(<ChatResearchSave chatId="chat-2" projectId="matter-2" />);
    fireEvent.click(screen.getByRole("button", { name: "Save research" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save research" }));
    await waitFor(() => expect(api.createResearchFile).toHaveBeenCalledWith({
      title: "Research", projectId: "matter-2",
    }));
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatResearchSave } from "./ChatResearchSave";

const api = vi.hoisted(() => ({ createResearchFile: vi.fn(), getResearchFile: vi.fn(),
  listDirectory: vi.fn(), listProjects: vi.fn(), promoteChatResearch: vi.fn(),
  directoryResource: vi.fn() }));
vi.mock("@/app/lib/beaverApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/beaverApi")>()), ...api,
}));
const document = { id: "file-1", filename: "Fairness.research.md", file_type: "md",
  project_id: null, pdf_storage_path: null, size_bytes: 1, page_count: null,
  created_at: null, current_version_id: "version-3" };
const file = { document, versionId: "version-3", workingRevision: 2, state: {} };

describe("ChatResearchSave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.directoryResource.mockReturnValue({ list: api.listDirectory });
    api.listDirectory.mockResolvedValue({ items: [], next_cursor: null });
    api.listProjects.mockResolvedValue({ items: [], next_cursor: null });
  });

  it("saves chat receipts to an existing ordinary research file", async () => {
    api.listDirectory.mockResolvedValue({ items: [
      { kind: "document", document },
      { kind: "document", document: { ...document, id: "other", filename: "Brief.pdf", file_type: "pdf" } },
    ], next_cursor: null });
    api.getResearchFile.mockResolvedValue(file);
    render(<ChatResearchSave chatId="chat-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Save sources" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("tab", { name: "Library" })).toBeVisible();
    expect(within(dialog).queryByRole("tab", { name: "Projects" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("tab", { name: "Templates" })).not.toBeInTheDocument();
    expect(api.directoryResource).toHaveBeenCalledWith({ library: "files" });
    expect(api.listProjects).not.toHaveBeenCalled();
    fireEvent.click(await within(dialog).findByLabelText("Select Fairness"));
    expect(within(dialog).queryByText("Brief.pdf")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText("Include model queries and match receipts"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save to workspace" }));
    await waitFor(() => expect(api.promoteChatResearch).toHaveBeenCalledWith({
      chatId: "chat-1", researchFileId: "file-1", versionId: "version-3",
      workingRevision: 2, includeQueries: true,
    }));
  });

  it("asks for a name before creating in the current project", async () => {
    api.createResearchFile.mockResolvedValue(file);
    render(<ChatResearchSave chatId="chat-2" projectId="matter-2" />);
    fireEvent.click(screen.getByRole("button", { name: "Save sources" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("tab")).not.toBeInTheDocument();
    expect(api.directoryResource).toHaveBeenCalledWith({ projectId: "matter-2" });
    fireEvent.click(within(dialog).getByRole("button", { name: "New workspace" }));
    fireEvent.submit(globalThis.document.getElementById("save-chat-research")!);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter a workspace name");
    expect(api.createResearchFile).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("Workspace name"), { target: { value: "Appeal research" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create and save" }));
    await waitFor(() => expect(api.createResearchFile).toHaveBeenCalledWith({
      title: "Appeal research", projectId: "matter-2",
    }));
    expect(api.promoteChatResearch).toHaveBeenCalledWith({
      chatId: "chat-2", researchFileId: "file-1", versionId: "version-3",
      workingRevision: 2, includeQueries: false,
    });
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ChatResearchSave } from "./ChatResearchSave";

const api = vi.hoisted(() => ({ createResearchFile: vi.fn(), getResearchFile: vi.fn(),
  listDirectory: vi.fn(), listProjects: vi.fn(), promoteChatResearch: vi.fn(),
  directoryResource: vi.fn(), createProject: vi.fn(), getChat: vi.fn(), createTableFromChat: vi.fn() }));
vi.mock("@/app/lib/api/chat", async (original) => ({
  ...await original<typeof import("@/app/lib/api/chat")>(), getChat: api.getChat, createTableFromChat: api.createTableFromChat,
}));
vi.mock("@/app/contexts/AuthContext", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  createResearchFile: api.createResearchFile,
  getResearchFile: api.getResearchFile,
  promoteChatResearch: api.promoteChatResearch
}));
vi.mock("@/app/lib/api/projects", async (original) => ({
  ...await original<typeof import("@/app/lib/api/projects")>(),
  listProjects: api.listProjects,
  createProject: api.createProject
}));
vi.mock("@/app/lib/api/documents", async (original) => ({
  ...await original<typeof import("@/app/lib/api/documents")>(),
  directoryResource: api.directoryResource
}));
const document = { id: "file-1", filename: "Fairness.research.md", file_type: "md",
  project_id: null, pdf_storage_path: null, size_bytes: 1, page_count: null,
  created_at: null, current_version_id: "version-3" };
const file = { document, versionId: "version-3", workingRevision: 2, state: {} };
function Location() {
  const location = useLocation();
  return <><output aria-label="Current location">{location.pathname}{location.search}</output>
    <output aria-label="Table intent">{location.state?.tableIntent}</output></>;
}
function renderSave(chatId = "chat-1", projectId?: string) {
  return render(<MemoryRouter><ChatResearchSave chatId={chatId} projectId={projectId} /><Location /></MemoryRouter>);
}
async function openWorkspace() {
  fireEvent.click(screen.getByRole("button", { name: "Open as" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Workspace" }));
  return screen.findByRole("dialog");
}

describe("ChatResearchSave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.directoryResource.mockReturnValue({ list: api.listDirectory });
    api.listDirectory.mockResolvedValue({ items: [], next_cursor: null });
    api.listProjects.mockResolvedValue({ items: [], next_cursor: null });
    api.getChat.mockResolvedValue({ chat: { id: "chat-1", research_file_id: null } });
  });

  it("saves chat receipts to an existing ordinary research file", async () => {
    api.listDirectory.mockResolvedValue({ items: [
      { kind: "document", document },
      { kind: "document", document: { ...document, id: "other", filename: "Brief.pdf", file_type: "pdf" } },
    ], next_cursor: null });
    api.getResearchFile.mockResolvedValue(file);
    renderSave();
    const dialog = await openWorkspace();
    expect(within(dialog).getByRole("tab", { name: "Library" })).toBeVisible();
    expect(within(dialog).getByRole("tab", { name: "Projects" })).toBeVisible();
    expect(within(dialog).queryByRole("tab", { name: "Templates" })).not.toBeInTheDocument();
    expect(api.directoryResource).toHaveBeenCalledWith({ library: "files" });
    expect(api.listProjects).not.toHaveBeenCalled();
    fireEvent.click(await within(dialog).findByLabelText("Select Fairness"));
    expect(within(dialog).queryByText("Brief.pdf")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open workspace" }));
    await waitFor(() => expect(api.promoteChatResearch).toHaveBeenCalledWith({
      chatId: "chat-1", researchFileId: "file-1", versionId: "version-3",
      workingRevision: 2, includeQueries: true,
    }));
  });

  it("creates the first project and makes it the workspace destination", async () => {
    api.createProject.mockResolvedValue({ id: "first-project", name: "Appeal" });
    api.createResearchFile.mockResolvedValue({ ...file, document: { ...document, project_id: "first-project" } });
    renderSave();
    await openWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "New workspace" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Appeal" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "New workspace" })).toBeEnabled());
    expect(screen.getByRole("tab", { name: "Projects" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(name, { target: { value: "Fairness" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(api.createResearchFile).toHaveBeenCalledWith({ title: "Fairness", projectId: "first-project" }));
    expect(await screen.findByLabelText("Select Fairness")).toBeChecked();
  });

  it("names a new workspace inline beside the existing files, then saves to it", async () => {
    api.listDirectory.mockResolvedValue({ items: [{ kind: "document", document }], next_cursor: null });
    const created = { ...file, document: { ...document, id: "new-file", project_id: "matter-2", filename: "Appeal research.research.md" } };
    api.createResearchFile.mockResolvedValue(created);
    api.getResearchFile.mockResolvedValue(created);
    renderSave("chat-2", "matter-2");
    const dialog = await openWorkspace();
    await within(dialog).findByLabelText("Select Fairness");
    fireEvent.click(within(dialog).getByRole("button", { name: "New workspace" }));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByLabelText("Select Fairness")).toBeVisible();
    const name = within(dialog).getByRole("textbox", { name: "Workspace name" });
    expect(name).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Open workspace" })).toBeDisabled();
    fireEvent.change(name, { target: { value: "Appeal research" } });
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.blur(name);
    expect(await within(dialog).findByLabelText("Select Appeal research")).toBeChecked();
    expect(api.createResearchFile).toHaveBeenCalledTimes(1);
    expect(api.createResearchFile).toHaveBeenCalledWith({ title: "Appeal research", projectId: "matter-2" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open workspace" }));
    await waitFor(() => expect(api.promoteChatResearch).toHaveBeenCalledWith({
      chatId: "chat-2", researchFileId: "new-file", versionId: "version-3",
      workingRevision: 2, includeQueries: true,
    }));
  });

  it("opens the linked workspace without asking for another destination", async () => {
    api.getChat.mockResolvedValue({ chat: { id: "chat-1", research_file_id: "file-1" } });
    renderSave();
    fireEvent.click(screen.getByRole("button", { name: "Open as" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Workspace" }));
    await waitFor(() => expect(screen.getByLabelText("Current location"))
      .toHaveTextContent("/sources?research_file=file-1"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.promoteChatResearch).not.toHaveBeenCalled();
  });

  it("opens recorded answers from a bound chat as a table", async () => {
    api.getChat.mockResolvedValue({ chat: { id: "chat-1", research_file_id: "file-1" } });
    api.createTableFromChat.mockResolvedValue({ id: "recorded-answers" });
    renderSave();
    fireEvent.click(screen.getByRole("button", { name: "Open as" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Table" }));
    await waitFor(() => expect(screen.getByLabelText("Current location"))
      .toHaveTextContent("/tabular-reviews/recorded-answers"));
    expect(api.createTableFromChat).toHaveBeenCalledWith("chat-1", "file-1");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the table assistant when existing research needs an arrangement", async () => {
    api.getChat.mockResolvedValue({ chat: { id: "chat-1", research_file_id: "file-1" } });
    api.createTableFromChat.mockResolvedValue({ id: "research-table", needs_arrangement: true });
    renderSave();
    fireEvent.click(screen.getByRole("button", { name: "Open as" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Table" }));
    await waitFor(() => expect(screen.getByLabelText("Current location"))
      .toHaveTextContent("/tabular-reviews/research-table?chat=new"));
    expect(screen.getByLabelText("Table intent")).toHaveTextContent("Arrange the linked research in this table");
  });
});

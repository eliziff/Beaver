import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile, ResearchSelection } from "@/app/lib/researchFiles";
import { ResearchWorkspaceViews, ResearchSourceAnswers, WorkspaceOrganize } from "./ResearchWorkspaceViews";
import { SourcesWorkspaceProvider } from "./SourcesWorkspace";
const api = vi.hoisted(() => ({ getWorkspaceViews: vi.fn(), openWorkspaceTable: vi.fn(),
  getResearchFile: vi.fn(), createChat: vi.fn(), getWorkspaceFindings: vi.fn(), bindWorkspaceView: vi.fn() }));
const assistant = vi.hoisted(() => ({ handleChat: vi.fn(async () => null), cancel: vi.fn(),
  state: { run: null as null | { id: string } }, chatLoad: { status: "loaded" } }));
vi.mock("@/app/hooks/useAssistantChat", () => ({ useAssistantChat: () => ({ state: assistant.state, chatLoad: assistant.chatLoad,
  actions: { handleChat: assistant.handleChat, cancel: assistant.cancel } }) }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  getWorkspaceViews: api.getWorkspaceViews, openWorkspaceTable: api.openWorkspaceTable,
  getResearchFile: api.getResearchFile, getWorkspaceFindings: api.getWorkspaceFindings, bindWorkspaceView: api.bindWorkspaceView }));
vi.mock("@/app/lib/api/chat", async (original) => ({ ...await original<typeof import("@/app/lib/api/chat")>(), createChat: api.createChat }));
const file = { document: { id: "workspace", filename: "Research.research.md", project_id: "project" },
  versionId: "v1", workingRevision: 0, state: { tables: ["table"], chats: ["chat"], labels: {}, sources: {
    source: { id: "source", reference: { provider: "a2aj", id: "case", kind: "case" }, labelIds: [], passages: null },
  } } } as ResearchFile;
function Location() { const location = useLocation(); return <output aria-label="Location">{location.pathname}{location.search} {location.state?.assistantIntent?.text}</output>; }
function setup(selection: ResearchSelection = { target: "sources" }) {
  render(<MemoryRouter><SourcesWorkspaceProvider file={file} selection={selection}><ResearchWorkspaceViews /><Location />
    </SourcesWorkspaceProvider></MemoryRouter>);
}
function open(name: "Table" | "Chat") { fireEvent.click(screen.getByRole("button", { name: "Open as" }));
  fireEvent.click(screen.getByRole("menuitem", { name })); }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); api.getResearchFile.mockResolvedValue(file);
  api.getWorkspaceViews.mockResolvedValue({ tables: [], chats: [] }); });
it("opens an available linked table", async () => {
  api.getWorkspaceViews.mockResolvedValue({ tables: [{ id: "table", title: "Current answers" }], chats: [] });
  api.openWorkspaceTable.mockResolvedValue({ id: "table" }); setup(); open("Table");
  fireEvent.click(await screen.findByRole("button", { name: "Current answers" }));
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/tabular-reviews/table"));
});
it("creates a chat attached to the current workspace and selection", async () => {
  const selection = { target: "passages" as const, evidenceIds: ["passage"] };
  api.createChat.mockResolvedValue({ id: "bound-chat" }); setup(selection); open("Chat");
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/projects/project/assistant/chat/bound-chat"));
  expect(api.createChat).toHaveBeenCalledWith({ research_file_id: "workspace", project_id: "project", research_selection: selection });
});
it("opens selected passages as a table without sending a hidden arrangement prompt", async () => {
  const selection = { target: "passages" as const, sourceIds: ["source"], evidenceIds: ["passage"] };
  api.openWorkspaceTable.mockResolvedValue({ id: "arranged-table", needs_arrangement: true }); setup(selection); open("Table");
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/tabular-reviews/arranged-table"));
  expect(screen.getByLabelText("Location")).not.toHaveTextContent("Arrange");
  expect(api.openWorkspaceTable).toHaveBeenCalledWith("workspace", { selection });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("pages supported findings and refreshes them after a workspace change", async () => {
  let title = "Original";
  api.getWorkspaceFindings.mockImplementation(async (_file, { offset }) => ({ items: [{
    reference: { kind: "answer", chatId: "chat", answerId: String(offset), resource: "source" },
    question: { id: String(offset), title: title + " " + offset, prompt: "Question" }, answer: { claims: [] }, evidence: [],
  }], next_offset: offset === 0 ? 1 : null }));
  const answers = (revision: number) => <SourcesWorkspaceProvider file={{ ...file, workingRevision: revision }}>
    <ResearchSourceAnswers sourceId="source" onCitation={vi.fn()} /></SourcesWorkspaceProvider>;
  const view = render(answers(0)); expect(await screen.findByText("Original 0")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "More answers" }));
  expect(await screen.findByText("Original 1")).toBeVisible();
  title = "Updated"; view.rerender(answers(1));
  expect(await screen.findByText("Updated 0")).toBeVisible();
  expect(screen.queryByText("Original 0")).not.toBeInTheDocument();
});

it("runs an organize request as a visible turn in the bound chat and refreshes when it finishes", async () => {
  const selection = { target: "sources" as const, sourceIds: ["source"] };
  api.getWorkspaceViews.mockResolvedValue({ tables: [], chats: [{ id: "chat", title: "Research" }] });
  api.bindWorkspaceView.mockResolvedValue(file);
  assistant.state = { run: null };
  const organize = () => <MemoryRouter><SourcesWorkspaceProvider file={file} selection={selection}>
    <WorkspaceOrganize open onClose={vi.fn()} /></SourcesWorkspaceProvider></MemoryRouter>;
  const view = render(organize());
  fireEvent.change(screen.getByRole("textbox", { name: "Organization request" }), { target: { value: "Group by remedy" } });
  fireEvent.click(screen.getByRole("button", { name: "Organize" }));
  await waitFor(() => expect(assistant.handleChat).toHaveBeenCalledWith({ role: "user", content: "Group by remedy",
    research_file_id: "workspace", research_selection: selection }));
  expect(api.bindWorkspaceView).toHaveBeenCalledWith("workspace", { chatId: "chat", selection });
  expect(api.createChat).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("Organizing");
  expect(screen.getByRole("link", { name: "Open chat" })).toHaveAttribute("href", "/projects/project/assistant/chat/chat");
  assistant.state = { run: { id: "run" } }; view.rerender(organize());
  assistant.state = { run: null }; view.rerender(organize());
  await waitFor(() => expect(api.getResearchFile).toHaveBeenCalledWith("workspace"));
  expect(await screen.findByRole("textbox", { name: "Organization request" })).toBeVisible();
});

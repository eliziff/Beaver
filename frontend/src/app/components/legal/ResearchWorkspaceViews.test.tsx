import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile, ResearchSelection } from "@/app/lib/researchFiles";
import { ResearchWorkspaceViews, ResearchSourceAnswers } from "./ResearchWorkspaceViews";
import { SourcesWorkspaceProvider } from "./SourcesWorkspace";
const api = vi.hoisted(() => ({ getWorkspaceViews: vi.fn(), openWorkspaceTable: vi.fn(),
  previewResearchTable: vi.fn(), getResearchFile: vi.fn(), createChat: vi.fn(), getWorkspaceFindings: vi.fn(), bindWorkspaceView: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  previewResearchTable: api.previewResearchTable, getWorkspaceViews: api.getWorkspaceViews, openWorkspaceTable: api.openWorkspaceTable,
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
  api.getWorkspaceViews.mockResolvedValue({ tables: [], chats: [] });
  api.previewResearchTable.mockResolvedValue({ title: "Research", basis: "basis", columns: [{ index: 0, name: "Reason", prompt: "Why?", fieldIds: ["question"] }],
    fields: [], reuse: [{ index: 0, reused: 1, unrun: 0 }], preview: [{ title: "Case", values: ["Existing grounded finding"] }], arrangement: { rows: [{ id: "source" }] } }); });
it("opens a table through the deterministic Research-set import", async () => {
  api.openWorkspaceTable.mockResolvedValue({ id: "table", project_id: "project" }); setup(); open("Table");
  expect(await screen.findByRole("dialog", { name: /Review existing research/u })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "Create review" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Create review" }));
  await waitFor(() => expect(api.openWorkspaceTable).toHaveBeenCalledWith("workspace", expect.objectContaining({ rows: "sources", basis: "basis", selection: { target: "sources" } })));
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/projects/project/tabular-reviews/table"));
});
it("creates a chat attached to the current workspace and selection", async () => {
  const selection = { target: "passages" as const, evidenceIds: ["passage"] };
  api.createChat.mockResolvedValue({ id: "bound-chat" }); setup(selection); open("Chat");
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/projects/project/assistant/chat/bound-chat"));
  expect(api.createChat).toHaveBeenCalledWith({ research_file_id: "workspace", project_id: "project", research_selection: selection });
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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider } from "../legal/SourcesWorkspace";
import { ChatFindingActions } from "./ChatFindingActions";
const api = vi.hoisted(() => ({ ensureSourcesWorkspace: vi.fn(), getWorkspaceFindings: vi.fn(), copyFindingsToMemo: vi.fn(),
  createChat: vi.fn(), saveChatDraft: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async original => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  ensureSourcesWorkspace: api.ensureSourcesWorkspace, getWorkspaceFindings: api.getWorkspaceFindings, copyFindingsToMemo: api.copyFindingsToMemo }));
vi.mock("@/app/lib/api/chat", async original => ({ ...await original<typeof import("@/app/lib/api/chat")>(),
  createChat: api.createChat, saveChatDraft: api.saveChatDraft }));
const file = { document: { id: "workspace", filename: "Research.research.md", project_id: "project" },
  versionId: "v1", workingRevision: 3, state: { sources: {}, labels: {} } } as ResearchFile;
const reference = { kind: "answer", chatId: "chat", answerId: "answer", resource: "source://a2aj/case", claimIndices: [1] };
const finding = { reference, sourceId: "source", resource: reference.resource, question: { title: "Notice" }, origin: {} };
function Location() { return <output aria-label="Location">{useLocation().pathname}</output>; }
function setup() {
  render(<MemoryRouter initialEntries={["/assistant/chat/chat"]}><SourcesWorkspaceProvider file={file}>
    <ChatFindingActions chatId="chat" messageId="message" /><Location />
  </SourcesWorkspaceProvider></MemoryRouter>);
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear();
  api.ensureSourcesWorkspace.mockResolvedValue(file); api.copyFindingsToMemo.mockResolvedValue({ ...file, workingRevision: 4 });
  api.createChat.mockResolvedValue({ id: "new-chat" }); api.saveChatDraft.mockResolvedValue({});
  api.getWorkspaceFindings.mockResolvedValue({ items: [finding], next_offset: null, total: 1 });
});
it("loads only the chosen parent answer on demand and appends its original references without a model call", async () => {
  api.getWorkspaceFindings.mockResolvedValueOnce({ items: [{ ...finding, origin: { subagentId: "reader" } }], next_offset: 1, total: 2 })
    .mockResolvedValueOnce({ items: [finding], next_offset: null, total: 2 });
  setup(); expect(api.getWorkspaceFindings).not.toHaveBeenCalled(); expect(api.ensureSourcesWorkspace).not.toHaveBeenCalled();
  const copy = screen.getByRole("button", { name: "Add to memo" }); fireEvent.click(copy); fireEvent.click(copy);
  await screen.findByText("Added to memo");
  expect(api.ensureSourcesWorkspace).toHaveBeenCalledExactlyOnceWith({ chatId: "chat" });
  expect(api.getWorkspaceFindings).toHaveBeenNthCalledWith(2, "workspace", { chatId: "chat", messageId: "message", offset: 1, limit: 50 });
  expect(api.copyFindingsToMemo).toHaveBeenCalledExactlyOnceWith(file, { title: "Notice", references: [reference] });
  expect(api.createChat).not.toHaveBeenCalled(); expect(api.saveChatDraft).not.toHaveBeenCalled();
});
it("starts a fresh composition draft scoped to the chosen findings, without submitting a model turn", async () => {
  setup(); fireEvent.click(screen.getByRole("button", { name: "Write from selection" }));
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/projects/project/assistant/chat/new-chat"));
  const selection = { target: "sources", sourceIds: ["source"], findingRefs: [reference] };
  expect(api.createChat).toHaveBeenCalledExactlyOnceWith({ project_id: "project", research_file_id: "workspace", research_selection: selection });
  expect(api.saveChatDraft).toHaveBeenCalledExactlyOnceWith("new-chat", { role: "user", research_file_id: "workspace", research_selection: selection,
    content: "Write a synthesis of the selected research. Preserve material qualifications and cite the original sources." });
  expect(api.copyFindingsToMemo).not.toHaveBeenCalled();
});
it("does not report a stale or failed memo write as successful and allows an explicit retry", async () => {
  api.copyFindingsToMemo.mockRejectedValueOnce(new Error("Workspace changed; reload and try again"));
  setup(); fireEvent.click(screen.getByRole("button", { name: "Add to memo" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Workspace changed");
  expect(screen.queryByText("Added to memo")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add to memo" }));
  expect(await screen.findByText("Added to memo")).toBeVisible();
  expect(api.ensureSourcesWorkspace).toHaveBeenCalledTimes(2);
});

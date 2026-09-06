import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { ResearchWorkspaceViews, useResearchAnswers } from "./ResearchWorkspaceViews";

const api = vi.hoisted(() => ({ getTabularReview: vi.fn(), createTabularReview: vi.fn(), getResearchFile: vi.fn(), getChat: vi.fn(), createChat: vi.fn(), getChatResearchAnswers: vi.fn() }));
vi.mock("@/app/lib/api/tabular", async (original) => ({ ...await original<typeof import("@/app/lib/api/tabular")>(),
  getTabularReview: api.getTabularReview, createTabularReview: api.createTabularReview }));
vi.mock("@/app/lib/api/researchFiles", () => ({ getResearchFile: api.getResearchFile }));
vi.mock("@/app/lib/api/chat", async (original) => ({ ...await original<typeof import("@/app/lib/api/chat")>(),
  getChat: api.getChat, createChat: api.createChat, getChatResearchAnswers: api.getChatResearchAnswers }));
const file = { document: { id: "workspace", filename: "Research.research.md", project_id: "project" }, versionId: "v1", workingRevision: 0,
  state: { tables: ["table"], chats: ["chat"], labels: {}, sources: {} } } as ResearchFile;
function Location() { const location = useLocation(); return <output aria-label="Location">{location.pathname}{location.search} {location.state?.tableIntent}</output>; }
beforeEach(() => vi.clearAllMocks());

it("opens the existing table even when another linked table is unavailable", async () => {
  api.getTabularReview.mockImplementation(async (id: string) => {
    if (id === "deleted") throw new Error("Not found");
    return { review: { id, title: "Current answers" } };
  });
  render(<MemoryRouter><ResearchWorkspaceViews file={{ ...file, state: { ...file.state, tables: ["deleted", "table"] } }}
    selection={{ target: "sources", sourceIds: ["source"] }} onChange={vi.fn()} /><Location /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Open as" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Table" }));
  fireEvent.click(await screen.findByRole("button", { name: "Current answers" }));
  expect(screen.getByLabelText("Location")).toHaveTextContent("/tabular-reviews/table");
});

it("creates a chat attached to the current workspace", async () => {
  api.createChat.mockResolvedValue({ id: "bound-chat" });
  render(<MemoryRouter><ResearchWorkspaceViews file={{ ...file, state: { ...file.state, chats: [] } }}
    selection={{ target: "sources", sourceIds: [] }} onChange={vi.fn()} /><Location /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Open as" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Chat" }));
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/projects/project/assistant/chat/bound-chat"));
  expect(api.createChat).toHaveBeenCalledWith({ research_file_id: "workspace", project_id: "project" });
});

it("opens selected workspace passages in the table assistant without a setup form", async () => {
  api.createTabularReview.mockResolvedValue({ id: "arranged-table" });
  api.getResearchFile.mockResolvedValue(file);
  const selection = { target: "passages" as const, sourceIds: ["source"], evidenceIds: ["passage"] };
  render(<MemoryRouter><ResearchWorkspaceViews file={{ ...file, state: { ...file.state, tables: [] } }}
    selection={selection} onChange={vi.fn()} /><Location /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Open as" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Table" }));
  await waitFor(() => expect(screen.getByLabelText("Location")).toHaveTextContent("/tabular-reviews/arranged-table?chat=new"));
  expect(screen.getByLabelText("Location")).toHaveTextContent("Arrange the selected research");
  expect(api.createTabularReview).toHaveBeenCalledWith(expect.objectContaining({
    research_file_id: "workspace", research_selection: selection, columns_config: [],
  }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("reads every page of recorded answers and refreshes the same linked chat after a revision", async () => {
  let revision = "Original";
  api.getChatResearchAnswers.mockImplementation(async (_chat, _file, offset) => ({
    items: [{ kind: "answer", resource: "source", question: { id: String(offset), title: `${revision} ${offset}` },
      answer: { claims: [] }, evidence: [] }], next_offset: offset === 0 ? 200 : null,
  }));
  function Answers({ revision }: { revision: number }) {
    const { findings } = useResearchAnswers({ ...file, workingRevision: revision, state: { ...file.state, tables: [] } });
    return <ul>{findings.map(({ id, column }) => <li key={id}>{column.name}</li>)}</ul>;
  }
  const view = render(<Answers revision={0} />);
  expect(await screen.findByText("Original 200")).toBeVisible();
  revision = "Updated"; view.rerender(<Answers revision={1} />);
  expect(await screen.findByText("Updated 200")).toBeVisible();
  expect(screen.queryByText("Original 0")).not.toBeInTheDocument();
});

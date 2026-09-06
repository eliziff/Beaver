import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchChange, ResearchFile } from "@/app/lib/researchFiles";
import type { TabularReview } from "@/app/lib/api/tabular";
import { ResearchChanges } from "./ResearchChanges";

const api = vi.hoisted(() => ({ getResearchItems: vi.fn(), act: vi.fn(), getTabularHistory: vi.fn(), actOnTabularChange: vi.fn() }));
vi.mock("@/app/lib/api/tabular", async (original) => ({ ...await original<typeof import("@/app/lib/api/tabular")>(),
  getTabularHistory: api.getTabularHistory, actOnTabularChange: api.actOnTabularChange }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({ ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  getResearchItems: api.getResearchItems }));
const change: ResearchChange = { id: "change-1", title: "Refine delivery terms", createdAt: "2026-09-05T12:00:00Z",
  executor: "assistant", status: "pending", counts: { labels: 1, sources: 0, passages: 0 }, changes: [
    { target: "label", id: "label-1", field: "name", before: "Other terms", after: "Delivery deadlines" },
  ] };
const original = { document: { id: "workspace" }, versionId: "v1", workingRevision: 0,
  state: { labels: { "label-1": { id: "label-1", name: "Other terms", parentId: null, scope: "source", order: 0, color: null } },
    sources: {}, proposals: [change], history: { count: 1, sha256: "before" } } } as ResearchFile;
function Example({ history = false }: { history?: boolean }) {
  const [file, setFile] = useState(original);
  return <><output aria-label="Current label">{file.state.labels["label-1"].name}</output>
    <ResearchChanges file={file} historyOpen={history} onCloseHistory={vi.fn()} mutations={{ query: vi.fn(),
      act: async (action) => { const next = await api.act(action); setFile(next); return next; } }} /></>;
}
beforeEach(() => { vi.clearAllMocks(); api.getResearchItems.mockResolvedValue({ items: [{ kind: "change", index: 0, value: change }], next_cursor: null }); });

it("keeps a proposed label unchanged until acceptance and offers undo", async () => {
  const accepted = { ...original, workingRevision: 1, state: { ...original.state, proposals: [], labels: {
    "label-1": { ...original.state.labels["label-1"], name: "Delivery deadlines" } } } };
  api.act.mockResolvedValueOnce(accepted).mockResolvedValueOnce({ ...original, state: { ...original.state, proposals: [] } });
  render(<Example />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(await screen.findByText("Refine delivery terms")).toBeVisible();
  expect(screen.getByLabelText("Current label")).toHaveTextContent("Other terms");
  fireEvent.click(screen.getByRole("button", { name: "Accept changes" }));
  await waitFor(() => expect(screen.getByLabelText("Current label")).toHaveTextContent("Delivery deadlines"));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(screen.getByLabelText("Current label")).toHaveTextContent("Other terms"));
  expect(api.act).toHaveBeenLastCalledWith({ type: "undo", changeId: "change-1" });
});

it("can keep existing labels without applying the proposal", async () => {
  api.act.mockResolvedValue({ ...original, state: { ...original.state, proposals: [] } });
  render(<Example />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  fireEvent.click(await screen.findByRole("button", { name: "Keep existing" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByLabelText("Current label")).toHaveTextContent("Other terms");
  expect(api.act).toHaveBeenCalledWith({ type: "reject", changeId: "change-1" });
});

it("finds a pending proposal beyond the first history page", async () => {
  api.getResearchItems.mockResolvedValueOnce({ items: [{ kind: "change", index: 0, value: { ...change, id: "newer", title: "Updated note", status: "applied" } }], next_cursor: "older" })
    .mockResolvedValueOnce({ items: [{ kind: "change", index: 1, value: change }], next_cursor: null });
  render(<Example />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(await screen.findByText("Refine delivery terms")).toBeVisible();
  expect(screen.queryByText("Updated note")).not.toBeInTheDocument();
});

it("uses the same review and undo controls for a proposed table edit", async () => {
  const tableChange: ResearchChange = { ...change, title: "Clarify the table", counts: { labels: 0, sources: 0, passages: 0, tables: 1 },
    changes: [{ target: "table", id: "table", field: "title", before: "Research", after: "Delivery comparison" }] };
  let saved = { id: "table", title: "Research", updated_at: "before", proposals: [tableChange] } as TabularReview;
  api.getTabularHistory.mockResolvedValue({ items: [tableChange], total: 1, next_offset: null });
  api.actOnTabularChange.mockImplementation(async (_review, _id, action) => saved = { ...saved,
    title: action === "accept" ? "Delivery comparison" : "Research", updated_at: action, proposals: [] });
  function Table() { const [review, setReview] = useState(saved);
    return <><output aria-label="Table title">{review.title}</output><ResearchChanges review={review} documents={[]}
      onChanged={async () => setReview(saved)} historyOpen={false} onCloseHistory={vi.fn()} /></>; }
  render(<Table />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  fireEvent.click(await screen.findByRole("button", { name: "Accept changes" }));
  await waitFor(() => expect(screen.getByLabelText("Table title")).toHaveTextContent("Delivery comparison"));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(screen.getByLabelText("Table title")).toHaveTextContent("Research"));
  expect(api.actOnTabularChange).toHaveBeenLastCalledWith(expect.objectContaining({ updated_at: "accept" }), "change-1", "undo");
});

it("names edited and removed columns when reviewing granular table changes", async () => {
  const proposal: ResearchChange = { ...change, title: "Refine columns", changes: [
    { target: "table", id: "table", field: "columns_config.7.prompt", before: "Find dates", after: "Find delivery deadlines" },
    { target: "table", id: "table", field: "columns_config.2.$", before: { name: "Legacy", prompt: "Find old terms", format: "text" }, after: null },
    { target: "table", id: "table", field: "columns_order", before: [2, 7], after: [7] },
  ] };
  api.getTabularHistory.mockResolvedValue({ items: [proposal], total: 1, next_offset: null });
  render(<ResearchChanges review={{ id: "table", title: "Research", proposals: [proposal], columns_config: [
    { index: 7, name: "Delivery", prompt: "Find dates" },
  ] } as TabularReview} documents={[]} onChanged={vi.fn()} historyOpen={false} onCloseHistory={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(await screen.findByText("Delivery · Prompt")).toBeVisible();
  expect(screen.getByText("Find delivery deadlines")).toBeVisible();
  expect(screen.getByText("Legacy")).toBeVisible();
  const order = screen.getByText("Research · Column order").closest("li")!;
  expect(order.querySelector("del")).toHaveTextContent("Legacy Delivery");
  expect(order.querySelector("ins")).toHaveTextContent("Delivery");
});

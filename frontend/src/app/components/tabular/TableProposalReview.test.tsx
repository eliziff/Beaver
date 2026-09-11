import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResearchChange } from "@/app/lib/researchFiles";
import type { TabularReview } from "@/app/lib/api/tabular";
import { ResearchChanges } from "../legal/ResearchChanges";

const api = vi.hoisted(() => ({ getTabularHistory: vi.fn(), actOnTabularChange: vi.fn(), updateTabularReview: vi.fn() }));
vi.mock("@/app/lib/api/tabular", async (original) => ({ ...await original<typeof import("@/app/lib/api/tabular")>(),
  getTabularHistory: api.getTabularHistory, actOnTabularChange: api.actOnTabularChange, updateTabularReview: api.updateTabularReview }));

const proposal: ResearchChange = { id: "change-1", title: "Rewrite the Amount prompt", createdAt: "2026-09-05T12:00:00Z",
  executor: "assistant", userId: "user-1", status: "pending", counts: { labels: 0, sources: 0, passages: 0, tables: 1 }, changes: [
    { target: "table", id: "table", field: "columns_config.0.prompt", before: "Find the amount", after: "Find the amount claimed" },
  ] };
const review = { id: "table", title: "Claims", updated_at: "v1", proposals: [proposal],
  columns_config: [{ index: 0, name: "Amount", prompt: "Find the amount", format: "text" }] } as TabularReview;

beforeEach(() => {
  vi.clearAllMocks();
  api.getTabularHistory.mockResolvedValue({ items: [proposal], total: 1, next_offset: null });
  api.actOnTabularChange.mockResolvedValue({ ...review, updated_at: "v2", proposals: [],
    columns_config: [{ index: 0, name: "Amount", prompt: "Find the amount claimed", format: "text" }] });
  api.updateTabularReview.mockResolvedValue({ ...review, updated_at: "v3", proposals: [] });
});
const open = () => {
  render(<ResearchChanges review={review} documents={[]} onChanged={vi.fn()} historyOpen={false} onCloseHistory={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  return screen.findByRole("region", { name: "Proposed columns" });
};

it("applies an edited proposal as one acceptance and one save against the accepted version", async () => {
  const form = await open();
  fireEvent.click(within(form).getByRole("button", { name: "Amount" }));
  fireEvent.change(await within(form).findByLabelText("Prompt"), { target: { value: "Find the settled amount" } });
  fireEvent.click(within(form).getByRole("button", { name: "Accept changes" }));

  await waitFor(() => expect(api.updateTabularReview).toHaveBeenCalledTimes(1));
  expect(api.actOnTabularChange).toHaveBeenCalledWith(review, "change-1", "accept");
  expect(api.updateTabularReview).toHaveBeenCalledWith("table", {
    columns_config: [{ index: 0, name: "Amount", prompt: "Find the settled amount", format: "text" }],
    expected_version: "v2",
  });
});

it("accepts an unedited proposal without a further save", async () => {
  const form = await open();
  fireEvent.click(within(form).getByRole("button", { name: "Accept changes" }));
  await waitFor(() => expect(api.actOnTabularChange).toHaveBeenCalledWith(review, "change-1", "accept"));
  expect(api.updateTabularReview).not.toHaveBeenCalled();
});

it("keeps the existing columns when the proposal is rejected", async () => {
  const form = await open();
  fireEvent.click(within(form).getByRole("button", { name: "Keep existing" }));
  await waitFor(() => expect(api.actOnTabularChange).toHaveBeenCalledWith(review, "change-1", "reject"));
  expect(api.updateTabularReview).not.toHaveBeenCalled();
});

it("marks a removed column and restores it with Keep", async () => {
  const removal: ResearchChange = { ...proposal, id: "change-2", title: "Drop Amount", changes: [
    { target: "table", id: "table", field: "columns_config.0.$",
      before: { index: 0, name: "Amount", prompt: "Find the amount", format: "text" }, after: null },
    { target: "table", id: "table", field: "columns_order", before: [0], after: [] },
  ] };
  api.getTabularHistory.mockResolvedValue({ items: [removal], total: 1, next_offset: null });
  render(<ResearchChanges review={{ ...review, proposals: [removal] }} documents={[]} onChanged={vi.fn()}
    historyOpen={false} onCloseHistory={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  const form = await screen.findByRole("region", { name: "Proposed columns" });
  expect(within(form).getByText("Removed")).toBeVisible();
  fireEvent.click(within(form).getByRole("button", { name: "Keep column 1" }));
  fireEvent.click(within(form).getByRole("button", { name: "Accept changes" }));

  await waitFor(() => expect(api.updateTabularReview).toHaveBeenCalledWith("table", {
    columns_config: [{ index: 0, name: "Amount", prompt: "Find the amount", format: "text" }],
    expected_version: "v2",
  }));
});
